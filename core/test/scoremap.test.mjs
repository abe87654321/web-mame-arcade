import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const repo = join(testDir, "..", "..");
const canonicalDir = join(repo, "core", "scoremap");
const publishedDir = join(repo, "packages", "web", "public", "static", "scoremap");

const canonicalFiles = readdirSync(canonicalDir).filter((file) =>
  file.endsWith(".json"),
);

test("every canonical scoremap has a byte-identical published copy", () => {
  // `packages/web/public/static/` is a gitignored build artifact, produced by
  // core/publish-web.sh; only compare when it exists (local dev after publish).
  if (!existsSync(publishedDir)) return;
  for (const file of canonicalFiles) {
    const published = join(publishedDir, file);
    assert.ok(existsSync(published), `missing published copy: ${published}`);
    assert.equal(
      readFileSync(published, "utf8"),
      readFileSync(join(canonicalDir, file), "utf8"),
      `published copy out of sync: ${file}`,
    );
  }
});

test("no orphan published scoremaps", () => {
  if (!existsSync(publishedDir)) return;
  for (const file of readdirSync(publishedDir).filter((f) =>
    f.endsWith(".json"),
  )) {
    assert.ok(
      existsSync(join(canonicalDir, file)),
      `published scoremap has no canonical source: ${file}`,
    );
  }
});
