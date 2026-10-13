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
  /** Match identity the verifier persists into `matches` (T34). */
  romHash: string;
  dips: Record<string, string | number>;
  mode: "solo" | "coop";
  /** Seated players with user ids, in slot order (T34). */
  players: { slot: number; userId: string; name: string }[];
  /** ISO timestamps of the match window (T34). */
  startedAt: string;
  endedAt: string;
}

/** Score result parsed from the MAME replay output. */
export interface SlotScore {
  slot: number;
  score: number;
}
