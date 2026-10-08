import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(here, "..", "determinism-spike.sh");
const run = (...args) => spawnSync("bash", [script, ...args], { encoding: "utf8" });

const binary = join(repoRoot, "mame", "gridlee");
const rom = join(repoRoot, "roms", "gridlee.zip");
const haveMame = existsSync(binary) && existsSync(rom);

test("--help exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("unknown driver is rejected", () => {
  const r = run("pacman", "--dry-run");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown driver: pacman/);
});

test("--dry-run default prints record and playback commands", () => {
  const r = run("--dry-run");
  assert.equal(r.status, 0);
  for (const flag of [
    "-record",
    "-playback",
    "-autoboot_script",
    "-nothrottle",
    "-video none",
    "-sound none",
    "-skip_gameinfo",
    "-noreadconfig",
  ]) {
    assert.match(r.stdout, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(r.stdout, /run\("record", 36000/);
  assert.match(r.stdout, /--rounds 10/);
  assert.match(r.stdout, /--replays 2/);
});

test("--dry-run honours --frames/--rounds/--replays", () => {
  const r = run("--dry-run", "--frames", "120", "--rounds", "1", "--replays", "2");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /run\("record", 120/);
});

test("invalid --timeout is rejected", () => {
  const r = run("gridlee", "--timeout", "0");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--timeout must be a positive integer/);
});

test("integration: strict short spike is deterministic", { skip: haveMame ? false : "mame/gridlee or roms/gridlee.zip missing" }, () => {
  const r = run("--frames", "120", "--rounds", "2", "--replays", "2");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RESULT: PASS/);
});

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms) => delay(ms);

// A fake emulator that ignores SIGTERM and spins forever, recording its pid.
// MAME behaves the same way when it hangs, which is why SIGKILL is required.
const makeHungEmulator = (dir) => {
  const pidFile = join(dir, "fake.pid");
  const fake = join(dir, "gridlee");
  writeFileSync(
    fake,
    "#!/usr/bin/env bash\n" +
      "trap '' TERM\n" +
      `echo $$ > '${pidFile}'\n` +
      "while true; do sleep 0.2; done\n",
  );
  chmodSync(fake, 0o755);
  const roms = join(dir, "roms");
  mkdirSync(roms);
  writeFileSync(join(roms, "gridlee.zip"), "not a real rom");
  return { fake, pidFile, roms };
};

const waitForPid = async (pidFile) => {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (pid > 0) return pid;
    }
    await sleep(50);
  }
  return 0;
};

test("a hung emulator is killed at the timeout and leaves no orphan", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wma-spike-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { fake, pidFile, roms } = makeHungEmulator(dir);

  const r = spawnSync(
    "bash",
    [
      script,
      "gridlee",
      "--binary", fake,
      "--rompath", roms,
      "--frames", "10",
      "--rounds", "1",
      "--replays", "1",
      "--timeout", "1",
    ],
    { encoding: "utf8", timeout: 30000 },
  );

  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RESULT: FAIL/);

  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "fake emulator did not record a pid");
  for (let i = 0; i < 20 && processAlive(pid); i += 1) {
    spawnSync("sleep", ["0.1"]);
  }
  assert.equal(processAlive(pid), false, `fake emulator ${pid} survived as an orphan`);
});

test("interrupting the spike kills a hung emulator (no orphan)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wma-spike-"));
  const { fake, pidFile, roms } = makeHungEmulator(dir);
  const child = spawn(
    "bash",
    [
      script,
      "gridlee",
      "--binary", fake,
      "--rompath", roms,
      "--frames", "10",
      "--rounds", "1",
      "--replays", "1",
      "--timeout", "600",
    ],
    { stdio: "ignore" },
  );
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  const pid = await waitForPid(pidFile);
  assert.ok(pid > 0, "fake emulator never started");

  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("exit", resolve));

  for (let i = 0; i < 20 && processAlive(pid); i += 1) {
    await sleep(100);
  }
  assert.equal(processAlive(pid), false, `orphan ${pid} survived interrupting the spike`);
});
