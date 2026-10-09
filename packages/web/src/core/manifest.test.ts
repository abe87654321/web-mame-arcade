import { describe, expect, it } from "vitest";
import { parseManifest, sha256Hex, verifyArtifact } from "./manifest";

const good = {
  driver: "gridlee",
  core_hash: "a".repeat(64),
  mame_commit: "b".repeat(40),
  emsdk: "6.0.2",
  artifacts: { "mamegridlee.wasm": "a".repeat(64) },
};

describe("parseManifest", () => {
  it("accepts the shape core/build-wasm.sh writes", () => {
    expect(parseManifest(good)).toEqual(good);
  });
  it("rejects a short core_hash", () => {
    expect(() => parseManifest({ ...good, core_hash: "abc" })).toThrow(/core_hash/);
  });
  it("rejects a non-40-hex mame_commit", () => {
    expect(() => parseManifest({ ...good, mame_commit: "zz" })).toThrow(/mame_commit/);
  });
  it("rejects a non-hex artifact hash", () => {
    expect(() =>
      parseManifest({ ...good, artifacts: { "x.wasm": "nope" } }),
    ).toThrow(/x\.wasm/);
  });
});

describe("sha256Hex", () => {
  it("matches the known hash of the empty input", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("verifyArtifact", () => {
  it("passes when bytes hash to the recorded value", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sum = await sha256Hex(bytes);
    const base = parseManifest({ ...good, artifacts: {} });
    await expect(
      verifyArtifact({ ...base, artifacts: { "x.bin": sum } }, "x.bin", bytes),
    ).resolves.toBeUndefined();
  });
  it("throws on a mismatch", async () => {
    const base = parseManifest({ ...good, artifacts: {} });
    await expect(
      verifyArtifact(
        { ...base, artifacts: { "x.bin": "0".repeat(64) } },
        "x.bin",
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/x\.bin/);
  });
});
