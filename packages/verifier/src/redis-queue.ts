/**
 * Redis-backed verification job queue. The relay uses this via the JobQueue
 * interface (packages/relay/src/job-queue.ts); the verifier worker itself
 * uses BRPOP directly for the polling loop.
 */
import type { VerifyJob } from "./job.js";

const VERIFY_JOBS_KEY = "verify:jobs";

export interface RedisConfig {
  url: string;
}

export function redisJobKey(): string {
  return VERIFY_JOBS_KEY;
}

/** Build the JSON payload for a VerifyJob. */
export function serializeJob(job: VerifyJob): string {
  return JSON.stringify(job);
}

/** Parse a VerifyJob from a JSON string. */
export function deserializeJob(raw: string): VerifyJob {
  return JSON.parse(raw) as VerifyJob;
}
