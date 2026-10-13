/** Score verifier worker (T33). */
export const serviceName = "@wma/verifier";

export { startWorker, processJob, ensureMatch } from "./worker.js";
export {
  createPool,
  flagMatch,
  insertVerifiedScore,
  markMatchVerified,
  getOrCreateGame,
  upsertMatch,
  upsertMatchPlayers,
} from "./db.js";
export { redisJobKey, serializeJob, deserializeJob } from "./redis-queue.js";
export type { VerifyJob, SlotScore } from "./job.js";
export type { WorkerOptions } from "./worker.js";
export type { PgPool, DbConfig, MatchInsert, GameKey } from "./db.js";
