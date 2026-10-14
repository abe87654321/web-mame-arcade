/** Score verifier worker (T33). */
export const serviceName = "@wma/verifier";

export { startWorker, processJob, ensureMatch, analyzeLog } from "./worker.js";
export {
  createPool,
  flagMatch,
  insertMatchFlag,
  insertVerifiedScore,
  markMatchVerified,
  getOrCreateGame,
  upsertMatch,
  upsertMatchPlayers,
} from "./db.js";
export { analyzeInputLog } from "./anti-cheat.js";
export type {
  AntiCheatCode,
  AntiCheatFlag,
  AntiCheatOptions,
  AntiCheatReport,
} from "./anti-cheat.js";
export { redisJobKey, serializeJob, deserializeJob } from "./redis-queue.js";
export type { VerifyJob, SlotScore } from "./job.js";
export type { WorkerOptions } from "./worker.js";
export type { PgPool, DbConfig, MatchInsert, GameKey } from "./db.js";
