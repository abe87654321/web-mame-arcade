import { describe, expect, it, vi } from "vitest";
import { loadCoreBundle } from "./loader";
import { sha256Hex } from "./manifest";
import type { CoreModule } from "./module";

function moduleStub(): CoreModule {
  return {
    FS: { mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn(), unlink: vi.fn() },
    HEAPU8: new Uint8Array(0),
    _malloc: vi.fn(() => 0),
    _free: vi.fn(),
    JSMAME: {
      save: vi.fn(), load: vi.fn(), soft_reset: vi.fn(), hard_reset: vi.fn(), exit: vi.fn(),
    },
  };
}

async function manifestFor(wasm: Uint8Array, js: Uint8Array) {
  const wasmHash = await sha256Hex(wasm);
  const jsHash = await sha256Hex(js);
  return {
    driver: "gridlee",
    core_hash: wasmHash,
    mame_commit: "b".repeat(40),
    emsdk: "6.0.2",
    artifacts: { "mamegridlee.wasm": wasmHash, "mamegridlee.js": jsHash },
  };
}

describe("loadCoreBundle", () => {
  it("verifies artifacts and core_hash, then boots", async () => {
    const wasm = new Uint8Array([1, 2, 3]);
    const js = new Uint8Array([4, 5]);
    const manifest = await manifestFor(wasm, js);
    const createModule = vi.fn(async () => moduleStub());
    const bundle = await loadCoreBundle(
      {
        manifestJson: manifest,
        fetchArtifact: async (n) => (n.endsWith(".wasm") ? wasm : js),
        createModule,
      },
      ["gridlee"],
    );
    expect(bundle.manifest.core_hash).toBe(manifest.core_hash);
    expect(createModule).toHaveBeenCalledWith(bundle.manifest, ["gridlee"]);
  });

  it("rejects a tampered artifact before booting", async () => {
    const wasm = new Uint8Array([1, 2, 3]);
    const manifest = await manifestFor(wasm, new Uint8Array([4]));
    const createModule = vi.fn(async () => moduleStub());
    await expect(
      loadCoreBundle(
        {
          manifestJson: manifest,
          fetchArtifact: async () => new Uint8Array([9, 9, 9]),
          createModule,
        },
        [],
      ),
    ).rejects.toThrow(/hash/);
    expect(createModule).not.toHaveBeenCalled();
  });

  it("rejects a manifest with no .wasm artifact", async () => {
    const manifest = await manifestFor(new Uint8Array([1]), new Uint8Array([2]));
    await expect(
      loadCoreBundle(
        {
          manifestJson: { ...manifest, artifacts: { "only.js": manifest.core_hash } },
          fetchArtifact: async () => new Uint8Array([1]),
          createModule: vi.fn(async () => moduleStub()),
        },
        [],
      ),
    ).rejects.toThrow(/\.wasm/);
  });
});
