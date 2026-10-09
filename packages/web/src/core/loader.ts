import { parseManifest, sha256Hex, verifyArtifact } from "./manifest";
import type { CoreModule } from "./module";
import type { CoreManifest } from "./types";

export interface CoreBundleSource {
  /** Raw manifest.json contents, already fetched. */
  readonly manifestJson: unknown;
  /** Fetch one named artifact from the bundle directory. */
  fetchArtifact(name: string): Promise<Uint8Array>;
  /** Create the runtime once the caller has verified the bundle. */
  createModule(
    manifest: CoreManifest,
    args: readonly string[],
  ): Promise<CoreModule>;
}

export interface CoreBundle {
  module: CoreModule;
  manifest: CoreManifest;
}

/**
 * Verify every core artifact against manifest.json (and that the .wasm hashes
 * to core_hash), then boot the module. A tampered core bundle never reaches
 * createModule. The ROM zip is fetched and mounted by the caller and is not
 * covered here; its `rom_hash` is checked when joining a room (T30/T33).
 */
export async function loadCoreBundle(
  source: CoreBundleSource,
  args: readonly string[],
): Promise<CoreBundle> {
  const manifest = parseManifest(source.manifestJson);
  const names = Object.keys(manifest.artifacts);
  const wasmName = names.find((name) => name.endsWith(".wasm"));
  if (!wasmName) {
    throw new Error("manifest: no .wasm artifact listed");
  }
  for (const name of names) {
    const bytes = await source.fetchArtifact(name);
    await verifyArtifact(manifest, name, bytes);
    if (name === wasmName) {
      const actual = await sha256Hex(bytes);
      if (actual !== manifest.core_hash) {
        throw new Error(
          `artifact ${name}: core_hash ${actual} != manifest ${manifest.core_hash}`,
        );
      }
    }
  }
  const module = await source.createModule(manifest, args);
  return { module, manifest };
}
