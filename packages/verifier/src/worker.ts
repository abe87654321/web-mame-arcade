/**
 * Verifier worker: polls Redis for verification jobs, runs native MAME to
 * replay each match, and writes the result to PostgreSQL + Redis.
 */
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { decodeInputLog } from "@wma/protocol";
import type { PgPool } from "./db.js";
import { analyzeInputLog } from "./anti-cheat.js";
import { deserializeJob, redisJobKey } from "./redis-queue.js";
import type { SlotScore, VerifyJob } from "./job.js";

export interface WorkerOptions {
  redisUrl: string;
  redisKey?: string;
  mameBin: string;
  romDir: string;
  scoremapDir: string;
  logDir: string;
  pgPool: PgPool;
  pinnedMameCommit: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const SCORE_LINE_RE = /^SCORE\s+(\d+)\s+(-?\d+)/;
const ERROR_LINE_RE = /^ERROR\s+(.+)/;

function parseMameOutput(stdout: string): { scores: SlotScore[]; errors: string[] } {
  const scores: SlotScore[] = [];
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    const scoreMatch = SCORE_LINE_RE.exec(line);
    if (scoreMatch) {
      scores.push({
        slot: parseInt(scoreMatch[1]!, 10),
        score: parseInt(scoreMatch[2]!, 10),
      });
      continue;
    }
    const errorMatch = ERROR_LINE_RE.exec(line);
    if (errorMatch) {
      errors.push(errorMatch[1]!);
    }
  }
  return { scores, errors };
}

async function runReplay(
  opts: Pick<WorkerOptions, "mameBin" | "romDir" | "scoremapDir" | "logDir">,
  job: VerifyJob,
  logPath: string,
): Promise<{ scores: SlotScore[]; errors: string[] }> {
  const scoremapPath = resolve(opts.scoremapDir, `${job.driver}.json`);

  const args = [
    job.driver,
    "-video",
    "none",
    "-sound",
    "none",
    "-nothrottle",
    "-rompath",
    opts.romDir,
    "-autoboot_script",
    "core/verify.lua",
  ];

  const env = {
    ...process.env,
    VERIFY_LOG_PATH: logPath,
    VERIFY_SCOREMAP: scoremapPath,
  };

  return new Promise((resolve) => {
    const proc = spawn(opts.mameBin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({
          scores: [],
          errors: [`mame exited with code ${code}: ${stderr}`],
        });
        return;
      }
      const { scores, errors } = parseMameOutput(stdout);
      resolve({ scores, errors });
    });

    proc.on("error", (err) => {
      resolve({ scores: [], errors: [`spawn error: ${err.message}`] });
    });
  });
}

/**
 * Create (or refresh) the `matches` + `match_players` rows for a job before it
 * is replayed, so a match can be flagged or verified even if the replay fails
 * (T34). `replay_key` is UNIQUE, so a redelivered job updates rather than
 * duplicates. Returns the match id.
 */
export async function ensureMatch(
  opts: Pick<WorkerOptions, "pgPool">,
  job: VerifyJob,
): Promise<bigint> {
  const { getOrCreateGame, upsertMatch, upsertMatchPlayers } = await import("./db.js");
  const gameId = await getOrCreateGame(opts.pgPool, {
    driver: job.driver,
    coreVersion: job.coreHash,
  });
  const matchId = await upsertMatch(opts.pgPool, {
    gameId,
    mode: job.mode,
    coreVersion: job.coreHash,
    mameCommit: job.mameCommit,
    romHash: job.romHash,
    dips: job.dips,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    replayKey: job.replayKey,
    status: "ended",
  });
  await upsertMatchPlayers(opts.pgPool, matchId, job.players);
  return matchId;
}

/**
 * Read the closed input log, run the pure anti-cheat analysis (T36), and
 * persist any findings as advisory `match_flags` rows. Never throws: a bad or
 * missing log must not break verification.
 */
export async function analyzeLog(
  opts: Pick<WorkerOptions, "logDir" | "pgPool" | "log">,
  job: VerifyJob,
  matchId: bigint,
): Promise<void> {
  const { logDir, log } = opts;
  const logPath = resolve(logDir, job.replayKey);
  try {
    const inputLog = decodeInputLog(gunzipSync(await readFile(logPath)));
    const report = analyzeInputLog(inputLog);
    if (!report.suspect) return;

    const { insertMatchFlag } = await import("./db.js");
    for (const flag of report.flags) {
      await insertMatchFlag(opts.pgPool, matchId, flag);
    }
    log?.("anti-cheat", {
      room: job.room,
      replayKey: job.replayKey,
      flags: report.flags,
    });
  } catch (err) {
    log?.("anti-cheat-error", {
      room: job.room,
      replayKey: job.replayKey,
      error: String(err),
    });
  }
}

export async function processJob(
  opts: WorkerOptions,
  job: VerifyJob,
): Promise<void> {
  const { mameBin, romDir, scoremapDir, logDir, pinnedMameCommit, log } = opts;

  // Persist the match identity first, so any rejection below still leaves a
  // `matches` row to flag (T34).
  let matchId: bigint;
  try {
    matchId = await ensureMatch(opts, job);
  } catch (err) {
    log?.("match-upsert-error", {
      room: job.room,
      replayKey: job.replayKey,
      error: String(err),
    });
    return;
  }

  if (job.mameCommit !== pinnedMameCommit) {
    log?.("job-rejected", {
      room: job.room,
      replayKey: job.replayKey,
      reason: "mame_commit_mismatch",
      expected: pinnedMameCommit,
      got: job.mameCommit,
    });
    await flagJob(opts, job, "mame_commit mismatch");
    return;
  }

  // Advisory anti-cheat pass on the closed log; independent of the replay, so
  // a finding is recorded even if the replay later fails (T36).
  await analyzeLog(opts, job, matchId);

  log?.("job-start", {
    room: job.room,
    replayKey: job.replayKey,
    driver: job.driver,
  });

  const logPath = resolve(logDir, job.replayKey);
  const { scores, errors } = await runReplay(
    { mameBin, romDir, scoremapDir, logDir },
    job,
    logPath,
  );

  if (errors.length > 0) {
    log?.("replay-error", {
      room: job.room,
      replayKey: job.replayKey,
      errors,
    });
    await flagJob(opts, job, `replay errors: ${errors.join("; ")}`);
    return;
  }

  if (scores.length === 0) {
    log?.("no-scores", {
      room: job.room,
      replayKey: job.replayKey,
    });
    await flagJob(opts, job, "no SCORE lines in MAME output");
    return;
  }

  log?.("replay-success", {
    room: job.room,
    replayKey: job.replayKey,
    scores,
  });

  await insertScores(opts, job, scores);
}

async function flagJob(
  opts: WorkerOptions,
  job: VerifyJob,
  reason: string,
): Promise<void> {
  const { pgPool, log } = opts;
  try {
    const { flagMatch } = await import("./db.js");
    await flagMatch(pgPool, job.replayKey);
    log?.("match-flagged", { replayKey: job.replayKey, reason });
  } catch (err) {
    log?.("flag-error", { replayKey: job.replayKey, error: String(err) });
  }
}

async function insertScores(
  opts: WorkerOptions,
  job: VerifyJob,
  verifiedScores: SlotScore[],
): Promise<void> {
  const { pgPool, log } = opts;
  try {
    const { findMatchByReplayKey, getMatchPlayers, insertVerifiedScore, markMatchVerified } =
      await import("./db.js");

    const match = await findMatchByReplayKey(pgPool, job.replayKey);
    if (!match) {
      log?.("match-not-found", { replayKey: job.replayKey });
      return;
    }

    const players = await getMatchPlayers(pgPool, match.matchId);
    const playerBySlot = new Map(players.map((p) => [p.slot, p.userId]));

    for (const vs of verifiedScores) {
      const userId = playerBySlot.get(vs.slot);
      if (userId === undefined) {
        log?.("unknown-slot", { slot: vs.slot, replayKey: job.replayKey });
        continue;
      }
      await insertVerifiedScore(
        pgPool,
        match.matchId,
        userId,
        match.gameId,
        BigInt(vs.score),
      );
    }

    await markMatchVerified(pgPool, job.replayKey);
    log?.("scores-inserted", { replayKey: job.replayKey, count: verifiedScores.length });
  } catch (err) {
    log?.("insert-error", { replayKey: job.replayKey, error: String(err) });
  }
}

/**
 * The blocking poll loop. Runs forever, processing jobs one at a time.
 */
export async function startWorker(opts: WorkerOptions): Promise<void> {
  const redisKey = opts.redisKey ?? redisJobKey();
  const redis = await import("redis").then((m) =>
    m.createClient({ url: opts.redisUrl }).connect(),
  );

  opts.log?.("worker-start", { redisKey });

  for (;;) {
    const result = await redis.brPop(redisKey, 5);
    if (!result) continue;

    const job = deserializeJob(result.element);
    await processJob(opts, job);
  }
}
