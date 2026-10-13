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
 * Returns null if the match has not been created yet (T34 hasn't run yet).
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
    userId: 0n, // T34: join with match_players
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
