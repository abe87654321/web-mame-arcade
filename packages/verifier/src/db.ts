/**
 * PostgreSQL operations for the verifier worker (T33).
 *
 * Writes verified scores to the `scores` table and updates `matches.status`.
 * The schema is in docs/contracts/db-schema.sql.
 */

const { Pool } = await import("pg") as { Pool: typeof import("pg").Pool };

export interface DbConfig {
  url: string;
}

export interface MatchInfo {
  matchId: bigint;
  gameId: number;
  userId: bigint;
}

export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export function createPool(config: DbConfig): PgPool {
  const pool = new Pool({ connectionString: config.url });
  return {
    async query(sql: string, params?: unknown[]) {
      return await pool.query(sql, params);
    },
    async end() {
      await pool.end();
    },
  };
}

/**
 * Insert a verified score. Idempotent: if the score for this (match, user)
 * already exists this is a no-op (the first verified write wins).
 */
export async function insertVerifiedScore(
  pool: PgPool,
  matchId: bigint,
  userId: bigint,
  gameId: number,
  score: bigint,
): Promise<void> {
  await pool.query(
    `INSERT INTO scores (match_id, user_id, game_id, score, verified_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT DO NOTHING`,
    [matchId, userId, gameId, score],
  );
}

/**
 * Flag a match for manual review because the verifier could not confirm the
 * score (RAM read error, MAME crash, or mismatch between reported and RAM).
 */
export async function flagMatch(
  pool: PgPool,
  replayKey: string,
): Promise<void> {
  await pool.query(
    `UPDATE matches SET status = 'flagged' WHERE replay_key = $1`,
    [replayKey],
  );
}

/**
 * Update a match's status to 'verified' after successful score insertion.
 */
export async function markMatchVerified(
  pool: PgPool,
  replayKey: string,
): Promise<void> {
  await pool.query(
    `UPDATE matches SET status = 'verified' WHERE replay_key = $1`,
    [replayKey],
  );
}

/**
 * Look up the match and player info for a given replay key.
 * Returns null if the match has not been created yet.
 */
export async function findMatchByReplayKey(
  pool: PgPool,
  replayKey: string,
): Promise<MatchInfo | null> {
  const result = await pool.query(
    `SELECT id, game_id FROM matches WHERE replay_key = $1`,
    [replayKey],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as { id: string; game_id: string };
  return {
    matchId: BigInt(row.id),
    gameId: parseInt(row.game_id, 10),
    userId: 0n, // match_players carries the real user ids
  };
}

/**
 * Get the list of (user_id, slot) pairs for a match.
 */
export async function getMatchPlayers(
  pool: PgPool,
  matchId: bigint,
): Promise<{ userId: bigint; slot: number }[]> {
  const result = await pool.query(
    `SELECT user_id, slot FROM match_players WHERE match_id = $1 ORDER BY slot`,
    [matchId],
  );
  return (result.rows as { user_id: string; slot: number }[]).map((r) => ({
    userId: BigInt(r.user_id),
    slot: r.slot,
  }));
}

export interface GameKey {
  driver: string;
  coreVersion: string;
}

/**
 * Resolve a `games.id` for `driver`, inserting a minimal row if the API has not
 * seeded it. An existing row keeps its title/metadata; only `core_version` is
 * refreshed to the core that actually played (T34).
 */
export async function getOrCreateGame(
  pool: PgPool,
  key: GameKey,
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO games
       (driver, title, core_version, supports_save, netplay_mode, max_players, rom_licensed)
     VALUES ($1, $1, $2, true, 'lockstep', 2, false)
     ON CONFLICT (driver) DO UPDATE SET core_version = EXCLUDED.core_version
     RETURNING id`,
    [key.driver, key.coreVersion],
  );
  return parseInt((result.rows[0] as { id: string }).id, 10);
}

export interface MatchInsert {
  gameId: number;
  mode: string;
  coreVersion: string;
  mameCommit: string;
  romHash: string;
  dips: Record<string, string | number>;
  startedAt: string;
  endedAt: string;
  replayKey: string;
  status: string;
}

/**
 * Create the match row (idempotent on `replay_key`) so the verifier can flag or
 * verify it. `replay_key` is UNIQUE (migration 0002), so an at-least-once job
 * redelivery does not create a duplicate match (T34).
 */
export async function upsertMatch(
  pool: PgPool,
  match: MatchInsert,
): Promise<bigint> {
  const result = await pool.query(
    `INSERT INTO matches
       (game_id, mode, core_version, mame_commit, rom_hash, dip_settings,
        started_at, ended_at, replay_key, status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
     ON CONFLICT (replay_key) DO UPDATE SET
       ended_at = EXCLUDED.ended_at,
       status = EXCLUDED.status
     RETURNING id`,
    [
      match.gameId,
      match.mode,
      match.coreVersion,
      match.mameCommit,
      match.romHash,
      JSON.stringify(match.dips),
      match.startedAt,
      match.endedAt,
      match.replayKey,
      match.status,
    ],
  );
  return BigInt((result.rows[0] as { id: string }).id);
}

/**
 * Record an anti-cheat finding (T36). Advisory only: this never changes the
 * match status or the verified score. Idempotent on `(match_id, reason, slot)`
 * so an at-least-once job redelivery does not duplicate flags.
 */
export async function insertMatchFlag(
  pool: PgPool,
  matchId: bigint,
  flag: { code: string; slot: number; detail: Record<string, unknown> },
): Promise<void> {
  await pool.query(
    `INSERT INTO match_flags (match_id, reason, slot, detail)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (match_id, reason, slot) DO NOTHING`,
    [matchId, flag.code, flag.slot, JSON.stringify(flag.detail)],
  );
}

/** Link seated players to a match; idempotent on (match_id, slot). */
export async function upsertMatchPlayers(
  pool: PgPool,
  matchId: bigint,
  players: { slot: number; userId: string }[],
): Promise<void> {
  for (const player of players) {
    await pool.query(
      `INSERT INTO match_players (match_id, user_id, slot)
       VALUES ($1, $2, $3)
       ON CONFLICT (match_id, slot) DO NOTHING`,
      [matchId, player.userId, player.slot],
    );
  }
}
