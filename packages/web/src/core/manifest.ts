import { sha256Bytes, toHex } from "./sha256";
import type { CoreManifest } from "./types";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

/** Validate the manifest written by core/build-wasm.sh, or throw. */
export function parseManifest(value: unknown): CoreManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("manifest: not an object");
  }
  const m = value as Record<string, unknown>;
  const { driver, core_hash, mame_commit, emsdk, artifacts } = m;
  if (typeof driver !== "string" || driver.length === 0) {
    throw new Error("manifest: bad driver");
  }
  if (typeof core_hash !== "string" || !HEX64.test(core_hash)) {
    throw new Error("manifest: bad core_hash");
  }
  if (typeof mame_commit !== "string" || !HEX40.test(mame_commit)) {
    throw new Error("manifest: bad mame_commit");
  }
  if (typeof emsdk !== "string" || emsdk.length === 0) {
    throw new Error("manifest: bad emsdk");
  }
  if (typeof artifacts !== "object" || artifacts === null) {
    throw new Error("manifest: bad artifacts");
  }
  const hashes: Record<string, string> = {};
  for (const [name, sum] of Object.entries(artifacts)) {
    if (typeof sum !== "string" || !HEX64.test(sum)) {
      throw new Error(`manifest: bad hash for ${name}`);
    }
    hashes[name] = sum;
  }
  return {
    driver,
    core_hash,
    mame_commit,
    emsdk,
    artifacts: hashes,
  };
}

/**
 * Lowercase-hex SHA-256 of the given bytes. Uses Web Crypto when available and
 * falls back to the bundled implementation otherwise (a non-secure LAN origin
 * has no `crypto.subtle`); both produce the same digest.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", new Uint8Array(bytes));
    return toHex(new Uint8Array(digest));
  }
  return toHex(sha256Bytes(bytes));
}

/** Throw unless `bytes` hashes to the manifest's recorded hash for `name`. */
export async function verifyArtifact(
  manifest: CoreManifest,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const expected = manifest.artifacts[name];
  if (!expected) {
    throw new Error(`manifest: no hash recorded for ${name}`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`artifact ${name}: hash ${actual} != manifest ${expected}`);
  }
}
