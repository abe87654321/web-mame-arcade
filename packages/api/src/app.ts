/**
 * Fastify application (T34). Routes only depend on a {@link PgPool}, the JWT
 * secret and optional config, so tests drive it with `app.inject()` and a fake
 * pool. See docs/06-backend-deploy.md for the service contract.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { PgPool } from "./pg.ts";
import {
  type GameRow,
  createUser,
  findGameByDriver,
  findUserByName,
  getMatch,
  listBoard,
  listGames,
} from "./db.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { issueSessionToken, type SessionClaims } from "./jwt.ts";

export interface AppOptions {
  pool: PgPool;
  /** HS256 secret shared with the relay (WMA_RELAY_SECRET). */
  secret: string;
  /** Session token lifetime in seconds; default 12h. */
  tokenTtlSec?: number;
  /** Public base URL for replay artifacts; default `/api/replays`. */
  replayBaseUrl?: string;
  /** Injectable clock (unix seconds) for token expiry tests. */
  now?: () => number;
}

const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_TTL_SEC = 12 * 60 * 60;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

function parseCredentials(
  body: unknown,
): { name: string; password: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { name, password } = body as { name?: unknown; password?: unknown };
  if (typeof name !== "string" || name.trim().length === 0) return null;
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return null;
  }
  return { name: name.trim(), password };
}

function serializeGame(game: GameRow): Record<string, unknown> {
  return {
    id: game.id,
    driver: game.driver,
    title: game.title,
    coreVersion: game.coreVersion,
    supportsSave: game.supportsSave,
    netplayMode: game.netplayMode,
    maxPlayers: game.maxPlayers,
    romLicensed: game.romLicensed,
  };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { pool, secret } = options;
  const ttlSec = options.tokenTtlSec ?? DEFAULT_TTL_SEC;
  const replayBaseUrl = options.replayBaseUrl ?? "/api/replays";
  const app = Fastify({ logger: false });

  const mint = (id: bigint, name: string): { token: string; claims: SessionClaims } =>
    issueSessionToken(
      options.now
        ? { sub: String(id), name, secret, ttlSec, now: options.now() }
        : { sub: String(id), name, secret, ttlSec },
    );

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/api/auth/register", async (request, reply: FastifyReply) => {
    const creds = parseCredentials(request.body);
    if (!creds) return reply.code(400).send({ error: "invalid_credentials" });
    const passwordHash = await hashPassword(creds.password);
    let user;
    try {
      user = await createUser(pool, creds.name, passwordHash);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: "name_taken" });
      }
      throw error;
    }
    const { token } = mint(user.id, user.name);
    return reply
      .code(201)
      .send({ token, user: { id: String(user.id), name: user.name } });
  });

  app.post("/api/auth/login", async (request, reply: FastifyReply) => {
    const creds = parseCredentials(request.body);
    if (!creds) return reply.code(400).send({ error: "invalid_credentials" });
    const user = await findUserByName(pool, creds.name);
    if (!user || !(await verifyPassword(creds.password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_login" });
    }
    const { token } = mint(user.id, user.name);
    return reply
      .code(200)
      .send({ token, user: { id: String(user.id), name: user.name } });
  });

  app.get("/api/games", async () => {
    const games = await listGames(pool);
    return { games: games.map(serializeGame) };
  });

  app.get<{ Params: { id: string } }>("/api/matches/:id", async (request, reply) => {
    const id = request.params.id;
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "invalid_id" });
    const detail = await getMatch(pool, BigInt(id));
    if (!detail) return reply.code(404).send({ error: "not_found" });
    return {
      match: {
        id: String(detail.match.id),
        driver: detail.match.driver,
        mode: detail.match.mode,
        coreVersion: detail.match.coreVersion,
        mameCommit: detail.match.mameCommit,
        romHash: detail.match.romHash,
        dips: detail.match.dips,
        startedAt: detail.match.startedAt,
        endedAt: detail.match.endedAt,
        status: detail.match.status,
        replayKey: detail.match.replayKey,
      },
      players: detail.players.map((p) => ({
        slot: p.slot,
        userId: String(p.userId),
        name: p.name,
      })),
      scores: detail.scores.map((s) => ({
        userId: String(s.userId),
        score: String(s.score),
        verifiedAt: s.verifiedAt,
      })),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/matches/:id/replay",
    async (request, reply) => {
      const id = request.params.id;
      if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "invalid_id" });
      const detail = await getMatch(pool, BigInt(id));
      if (!detail) return reply.code(404).send({ error: "not_found" });
      if (!detail.match.replayKey) {
        return reply.code(404).send({ error: "no_replay" });
      }
      return {
        matchId: String(detail.match.id),
        replayKey: detail.match.replayKey,
        url: `${replayBaseUrl}/${encodeURIComponent(detail.match.replayKey)}`,
      };
    },
  );

  const PERIOD_MS: Record<string, number> = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
  };

  app.get<{ Params: { driver: string }; Querystring: { period?: string } }>(
    "/api/leaderboards/:driver",
    async (request, reply) => {
      const period = request.query.period ?? "all";
      if (period !== "all" && !(period in PERIOD_MS)) {
        return reply.code(400).send({ error: "invalid_period" });
      }
      const game = await findGameByDriver(pool, request.params.driver);
      if (!game) return reply.code(404).send({ error: "unknown_game" });

      const since =
        period === "all"
          ? null
          : new Date(Date.now() - PERIOD_MS[period]!).toISOString();
      const rows = await listBoard(pool, game.id, since);

      // Best score per user, preserving the query's score-desc order.
      const best = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (!best.has(String(row.userId))) best.set(String(row.userId), row);
      }
      const entries = [...best.values()].map((row, index) => ({
        rank: index + 1,
        userId: String(row.userId),
        name: row.userName,
        score: String(row.score),
        matchId: String(row.matchId),
        replayUrl: row.replayKey
          ? `${replayBaseUrl}/${encodeURIComponent(row.replayKey)}`
          : null,
        achievedAt: row.achievedAt,
      }));
      return { driver: game.driver, period, entries };
    },
  );

  return app;
}
