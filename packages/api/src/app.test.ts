import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { hashPassword } from "./password";
import type { PgPool } from "./pg";

const SECRET = "test-api-secret";
const query = vi.fn();
const pool: PgPool = {
  async query(sql, params) {
    return query(sql, params) as Promise<{ rows: unknown[] }>;
  },
  async end() {},
};

let app: FastifyInstance;
beforeEach(() => {
  query.mockReset();
  app = buildApp({ pool, secret: SECRET, now: () => 1_700_000_000 });
});

const userRow = {
  id: "5",
  name: "alice",
  password_hash: "scrypt$aa$bb",
  country: null,
};

describe("health", () => {
  it("returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("POST /api/auth/register", () => {
  it("creates a user and returns a relay-verifiable token", async () => {
    query.mockResolvedValueOnce({ rows: [userRow] });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "alice", password: "password123" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toEqual({ id: "5", name: "alice" });

    const { createHs256Verifier } = await import("@wma/relay");
    const claims = createHs256Verifier(SECRET, {
      now: () => 1_700_000_000,
    }).verify(body.token);
    expect(claims).toEqual({ sub: "5", name: "alice", exp: 1_700_000_000 + 43_200 });
  });

  it("rejects a short password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "alice", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 409 on a duplicate name", async () => {
    query.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "alice", password: "password123" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "name_taken" });
  });
});

describe("POST /api/auth/login", () => {
  it("returns a token for correct credentials", async () => {
    const passwordHash = await hashPassword("password123");
    query.mockResolvedValueOnce({ rows: [{ ...userRow, password_hash: passwordHash }] });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { name: "alice", password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ id: "5", name: "alice" });
  });

  it("returns 401 for a wrong password", async () => {
    const passwordHash = await hashPassword("password123");
    query.mockResolvedValueOnce({ rows: [{ ...userRow, password_hash: passwordHash }] });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { name: "alice", password: "not-the-password" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an unknown user", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { name: "ghost", password: "password123" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/games", () => {
  it("lists the catalogue", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          driver: "gridlee",
          title: "Gridlee",
          core_version: "c".repeat(64),
          supports_save: true,
          netplay_mode: "lockstep",
          max_players: 2,
          rom_licensed: true,
        },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/api/games" });
    expect(res.statusCode).toBe(200);
    expect(res.json().games[0]).toMatchObject({ driver: "gridlee", title: "Gridlee" });
  });
});

const matchRow = {
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
};

describe("GET /api/matches/:id", () => {
  it("returns match detail", async () => {
    query
      .mockResolvedValueOnce({ rows: [matchRow] })
      .mockResolvedValueOnce({ rows: [{ slot: 0, user_id: "5", name: "alice" }] })
      .mockResolvedValueOnce({
        rows: [{ user_id: "5", score: "100", verified_at: "2026-01-01T00:06:00.000Z" }],
      });
    const res = await app.inject({ method: "GET", url: "/api/matches/9" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.match).toMatchObject({ id: "9", driver: "gridlee" });
    expect(body.players).toEqual([{ slot: 0, userId: "5", name: "alice" }]);
    expect(body.scores[0]).toEqual({
      userId: "5",
      score: "100",
      verifiedAt: "2026-01-01T00:06:00.000Z",
    });
  });

  it("404s an unknown match", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({ method: "GET", url: "/api/matches/9" });
    expect(res.statusCode).toBe(404);
  });

  it("400s a non-numeric id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/matches/abc" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/matches/:id/replay", () => {
  it("returns the replay key and url", async () => {
    query
      .mockResolvedValueOnce({ rows: [matchRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({ method: "GET", url: "/api/matches/9/replay" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      matchId: "9",
      replayKey: "match/r/1.json.gz",
      url: "/api/replays/match%2Fr%2F1.json.gz",
    });
  });

  it("404s when the match has no replay", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ ...matchRow, replay_key: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({ method: "GET", url: "/api/matches/9/replay" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no_replay" });
  });
});

describe("GET /api/leaderboards/:driver", () => {
  const gameRow = {
    id: 1,
    driver: "gridlee",
    title: "Gridlee",
    core_version: "c".repeat(64),
    supports_save: true,
    netplay_mode: "lockstep",
    max_players: 2,
    rom_licensed: true,
  };

  it("returns the best verified score per user with replay links", async () => {
    query
      .mockResolvedValueOnce({ rows: [gameRow] })
      .mockResolvedValueOnce({
        rows: [
          {
            score: "100",
            user_id: "5",
            user_name: "alice",
            match_id: "9",
            replay_key: "match/r/1.json.gz",
            verified_at: "2026-01-01T00:06:00.000Z",
          },
          {
            score: "80",
            user_id: "5",
            user_name: "alice",
            match_id: "8",
            replay_key: null,
            verified_at: "2025-12-01T00:06:00.000Z",
          },
        ],
      });
    const res = await app.inject({ method: "GET", url: "/api/leaderboards/gridlee" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.period).toBe("all");
    expect(body.entries).toEqual([
      {
        rank: 1,
        userId: "5",
        name: "alice",
        score: "100",
        matchId: "9",
        replayUrl: "/api/replays/match%2Fr%2F1.json.gz",
        achievedAt: "2026-01-01T00:06:00.000Z",
      },
    ]);
  });

  it("computes a 'since' timestamp for period boards", async () => {
    query
      .mockResolvedValueOnce({ rows: [gameRow] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: "GET",
      url: "/api/leaderboards/gridlee?period=day",
    });
    expect(res.statusCode).toBe(200);
    const [, params] = query.mock.calls[1]!;
    expect(params[0]).toBe(1);
    expect(typeof params[1]).toBe("string");
  });

  it("404s an unknown driver and 400s a bad period", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const missing = await app.inject({ method: "GET", url: "/api/leaderboards/nope" });
    expect(missing.statusCode).toBe(404);

    query.mockReset();
    const bad = await app.inject({
      method: "GET",
      url: "/api/leaderboards/gridlee?period=hour",
    });
    expect(bad.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
