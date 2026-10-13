/**
 * PostgreSQL operations for the API (T34). Schema: docs/contracts/db-schema.sql.
 * Everything takes a {@link PgPool} so routes are unit-tested without a live
 * database (the T33 verifier uses the same pattern).
 */
import type { PgPool } from "./pg.ts";

export interface UserRow {
  id: bigint;
  name: string;
  passwordHash: string;
  country: string | null;
}

export interface GameRow {
  id: number;
  driver: string;
  title: string;
  coreVersion: string;
  supportsSave: boolean;
  netplayMode: string;
  maxPlayers: number;
  romLicensed: boolean;
}

export interface NewGame {
  driver: string;
  title: string;
  coreVersion: string;
  supportsSave: boolean;
  netplayMode: string;
  maxPlayers: number;
  romLicensed: boolean;
}

export interface BoardEntry {
  score: bigint;
  userId: bigint;
  userName: string;
  matchId: bigint;
  replayKey: string | null;
  achievedAt: string;
}

export interface MatchRow {
  id: bigint;
  gameId: number;
  driver: string;
  mode: string;
  coreVersion: string;
  mameCommit: string;
  romHash: string;
  dips: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  replayKey: string | null;
  status: string;
}

export interface MatchPlayerRow {
  slot: number;
  userId: bigint;
  name: string;
}

export interface MatchScoreRow {
  userId: bigint;
  score: bigint;
  verifiedAt: string;
}

/** Insert a user; relies on the UNIQUE(name) constraint to reject duplicates. */
export async function createUser(
  pool: PgPool,
  name: string,
  passwordHash: string,
): Promise<UserRow> {
  const { rows } = await pool.query(
    `INSERT INTO users (name, password_hash) VALUES ($1, $2)
     RETURNING id, name, password_hash, country`,
    [name, passwordHash],
  );
  return mapUser(rows[0] as RawUser);
}

export async function findUserByName(
  pool: PgPool,
  name: string,
): Promise<UserRow | null> {
  const { rows } = await pool.query(
    `SELECT id, name, password_hash, country FROM users WHERE name = $1`,
    [name],
  );
  return rows.length === 0 ? null : mapUser(rows[0] as RawUser);
}

/** All catalogue games, in driver order. */
export async function listGames(pool: PgPool): Promise<GameRow[]> {
  const { rows } = await pool.query(
    `SELECT id, driver, title, core_version, supports_save, netplay_mode,
            max_players, rom_licensed
       FROM games ORDER BY driver`,
  );
  return (rows as RawGame[]).map(mapGame);
}

export async function findGameByDriver(
  pool: PgPool,
  driver: string,
): Promise<GameRow | null> {
  const { rows } = await pool.query(
    `SELECT id, driver, title, core_version, supports_save, netplay_mode,
            max_players, rom_licensed
       FROM games WHERE driver = $1`,
    [driver],
  );
  return rows.length === 0 ? null : mapGame(rows[0] as RawGame);
}

/** Insert or update a catalogue game by driver (seed + verifier fallback). */
export async function upsertGame(pool: PgPool, game: NewGame): Promise<void> {
  await pool.query(
    `INSERT INTO games
       (driver, title, core_version, supports_save, netplay_mode, max_players, rom_licensed)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (driver) DO UPDATE SET
       title = EXCLUDED.title,
       core_version = EXCLUDED.core_version,
       supports_save = EXCLUDED.supports_save,
       netplay_mode = EXCLUDED.netplay_mode,
       max_players = EXCLUDED.max_players,
       rom_licensed = EXCLUDED.rom_licensed`,
    [
      game.driver,
      game.title,
      game.coreVersion,
      game.supportsSave,
      game.netplayMode,
      game.maxPlayers,
      game.romLicensed,
    ],
  );
}

/**
 * Best verified score per user for a board, best first. `since` is an ISO
 * timestamp or null for all-time. The best row is chosen in SQL (`DISTINCT ON`)
 * so a `LIMIT` cannot truncate a user out of the board before deduplication.
 */
export async function listBoard(
  pool: PgPool,
  gameId: number,
  since: string | null,
  limit = 100,
): Promise<BoardEntry[]> {
  const { rows } = await pool.query(
    `SELECT best.score, best.user_id, best.user_name, best.match_id,
            best.replay_key, best.verified_at
       FROM (
         SELECT DISTINCT ON (s.user_id)
                s.score, s.user_id, u.name AS user_name, s.match_id,
                m.replay_key, s.verified_at
           FROM scores s
           JOIN users u ON u.id = s.user_id
           JOIN matches m ON m.id = s.match_id
          WHERE s.game_id = $1
            AND ($2::timestamptz IS NULL OR s.verified_at >= $2)
          ORDER BY s.user_id, s.score DESC, s.verified_at ASC
       ) best
      ORDER BY best.score DESC, best.verified_at ASC
      LIMIT $3`,
    [gameId, since, limit],
  );
  return (rows as RawBoard[]).map((row) => ({
    score: BigInt(row.score),
    userId: BigInt(row.user_id),
    userName: row.user_name,
    matchId: BigInt(row.match_id),
    replayKey: row.replay_key,
    achievedAt: row.verified_at,
  }));
}

export interface MatchDetail {
  match: MatchRow;
  players: MatchPlayerRow[];
  scores: MatchScoreRow[];
}

export async function getMatch(
  pool: PgPool,
  matchId: bigint,
): Promise<MatchDetail | null> {
  const { rows } = await pool.query(
    `SELECT m.id, m.game_id, g.driver, m.mode, m.core_version, m.mame_commit,
            m.rom_hash, m.dip_settings, m.started_at, m.ended_at, m.replay_key, m.status
       FROM matches m JOIN games g ON g.id = m.game_id
      WHERE m.id = $1`,
    [matchId],
  );
  if (rows.length === 0) return null;
  const match = mapMatch(rows[0] as RawMatch);

  const [{ rows: playerRows }, { rows: scoreRows }] = await Promise.all([
    pool.query(
      `SELECT mp.slot, mp.user_id, u.name
         FROM match_players mp JOIN users u ON u.id = mp.user_id
        WHERE mp.match_id = $1 ORDER BY mp.slot`,
      [matchId],
    ),
    pool.query(
      `SELECT user_id, score, verified_at FROM scores WHERE match_id = $1`,
      [matchId],
    ),
  ]);

  return {
    match,
    players: (playerRows as { slot: number; user_id: string; name: string }[]).map(
      (row) => ({ slot: row.slot, userId: BigInt(row.user_id), name: row.name }),
    ),
    scores: (scoreRows as { user_id: string; score: string; verified_at: string }[]).map(
      (row) => ({
        userId: BigInt(row.user_id),
        score: BigInt(row.score),
        verifiedAt: row.verified_at,
      }),
    ),
  };
}

interface RawUser {
  id: string;
  name: string;
  password_hash: string;
  country: string | null;
}
interface RawGame {
  id: number;
  driver: string;
  title: string;
  core_version: string;
  supports_save: boolean;
  netplay_mode: string;
  max_players: number;
  rom_licensed: boolean;
}
interface RawBoard {
  score: string;
  user_id: string;
  user_name: string;
  match_id: string;
  replay_key: string | null;
  verified_at: string;
}
interface RawMatch {
  id: string;
  game_id: number;
  driver: string;
  mode: string;
  core_version: string;
  mame_commit: string;
  rom_hash: string;
  dip_settings: Record<string, unknown>;
  started_at: string;
  ended_at: string | null;
  replay_key: string | null;
  status: string;
}

function mapUser(row: RawUser): UserRow {
  return {
    id: BigInt(row.id),
    name: row.name,
    passwordHash: row.password_hash,
    country: row.country,
  };
}
function mapGame(row: RawGame): GameRow {
  return {
    id: row.id,
    driver: row.driver,
    title: row.title,
    coreVersion: row.core_version,
    supportsSave: row.supports_save,
    netplayMode: row.netplay_mode,
    maxPlayers: row.max_players,
    romLicensed: row.rom_licensed,
  };
}
function mapMatch(row: RawMatch): MatchRow {
  return {
    id: BigInt(row.id),
    gameId: row.game_id,
    driver: row.driver,
    mode: row.mode,
    coreVersion: row.core_version,
    mameCommit: row.mame_commit,
    romHash: row.rom_hash,
    dips: row.dip_settings,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    replayKey: row.replay_key,
    status: row.status,
  };
}
