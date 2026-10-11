/**
 * Verification job queue (docs/05 step 1: "pushes a job to Redis list
 * verify:jobs"). T30 defines the shape and an in-memory sink; the real Redis
 * client is wired with the verifier worker (T33) / deploy (T42).
 */

/** One closed match handed to the verifier. */
export interface VerifyJob {
  room: string;
  /** Object-storage key of the gzip(JSON) input log. */
  replayKey: string;
  driver: string;
  coreHash: string;
  mameCommit: string;
}

export interface JobQueue {
  /** Enqueue a verification job; resolves once handed off. */
  enqueue(job: VerifyJob): Promise<void>;
}

export interface MemoryJobQueue extends JobQueue {
  jobs: VerifyJob[];
}

export function createMemoryJobQueue(): MemoryJobQueue {
  const jobs: VerifyJob[] = [];
  return {
    jobs,
    enqueue: async (job) => {
      jobs.push(job);
    },
  };
}
