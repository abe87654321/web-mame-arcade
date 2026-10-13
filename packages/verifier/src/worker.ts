/**
 * Verifier worker: polls Redis for verification jobs, runs native MAME to
 * replay each match, and writes the result to PostgreSQL + Redis.
 */
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import type { PgPool } from "./db.js";
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

export async function processJob(
  opts: WorkerOptions,
  job: VerifyJob,
): Promise<void> {
  const { mameBin, romDir, scoremapDir, logDir, pinnedMameCommit, log } = opts;

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
