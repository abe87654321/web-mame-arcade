/**
 * REST API service (T34).
 */
export const serviceName = "@wma/api";

export { buildApp, type AppOptions } from "./app.ts";
export {
  createPool,
  type PgPool,
  type PgClient,
  type PgQueryable,
  type QueryResult,
  type DbConfig,
} from "./pg.ts";
export {
  applyMigrations,
  loadMigrations,
  migrate,
  migrationsDir,
  type Migration,
} from "./migrate.ts";
export {
  loadCatalogue,
  seedGames,
  toNewGame,
  type CatalogueEntry,
} from "./seed.ts";
export {
  createUser,
  findGameByDriver,
  findUserByName,
  getMatch,
  listBoard,
  listGames,
  upsertGame,
  type BoardEntry,
  type GameRow,
  type MatchDetail,
  type MatchPlayerRow,
  type MatchRow,
  type MatchScoreRow,
  type NewGame,
  type UserRow,
} from "./db.ts";
export { hashPassword, verifyPassword } from "./password.ts";
export { issueSessionToken, signHs256, type SessionClaims } from "./jwt.ts";
export { readReplay, ReplayNotFound } from "./replays.ts";
