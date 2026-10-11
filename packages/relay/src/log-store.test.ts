import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalDiskLogStore,
  createMemoryLogStore,
  readLocalLog,
} from "./log-store";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("memory log store", () => {
  it("stores and reads bytes by key", async () => {
    const store = createMemoryLogStore();
    await store.put("match/r/1.json.gz", new Uint8Array([1, 2, 3]));
    expect(store.get("match/r/1.json.gz")).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.keys()).toEqual(["match/r/1.json.gz"]);
  });
});

describe("local disk log store", () => {
  it("writes the artifact under the configured directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wma-logs-"));
    dirs.push(dir);
    const store = createLocalDiskLogStore({ dir });
    await store.put("match/r/1.json.gz", new Uint8Array([9, 8, 7]));
    expect(await readLocalLog(dir, "match/r/1.json.gz")).toEqual(
      new Uint8Array([9, 8, 7]),
    );
  });

  it("refuses a key that escapes the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wma-logs-"));
    dirs.push(dir);
    const store = createLocalDiskLogStore({ dir });
    await expect(store.put("../escape", new Uint8Array([1]))).rejects.toThrow(
      /escapes/,
    );
  });
});
