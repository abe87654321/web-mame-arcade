/**
 * Verification job shape. Mirrors the relay's job-queue.ts VerifyJob so the
 * verifier and relay packages stay in sync without a shared dependency.
 */
export interface VerifyJob {
  room: string;
  /** Object-storage key of the gzip(JSON) input log. */
  replayKey: string;
  driver: string;
  coreHash: string;
  mameCommit: string;
}

/** Score result parsed from the MAME replay output. */
export interface SlotScore {
  slot: number;
  score: number;
}
