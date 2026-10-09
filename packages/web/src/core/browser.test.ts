import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBrowserCore } from "./browser";
import { sha256Hex } from "./manifest";

interface TestModule {
  FS: {
    mkdir: (p: string) => void;
    writeFile: (p: string, d: Uint8Array) => void;
    readFile: (p: string) => Uint8Array;
    unlink: (p: string) => void;
  };
  JSMAME: Record<string, () => void>;
  HEAPU8: Uint8Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  preRun: Array<() => void>;
  onRuntimeInitialized: () => void;
  arguments?: unknown;
}

function fakeFetch(routes: Record<string, Uint8Array | object>): typeof fetch {
  return (async (url: string) => {
    const body = routes[url];
    if (body === undefined) {
      return { ok: false, status: 404 } as unknown as Response;
    }
    if (body instanceof Uint8Array) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => body.slice().buffer as ArrayBuffer,
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Module;
});

describe("loadBrowserCore", () => {
  it("verifies the bundle, mounts the ROM via preRun, and returns a Core", async () => {
    const wasm = new Uint8Array([1, 2, 3]);
    const js = new Uint8Array([4, 5]);
    const rom = new Uint8Array([6, 7, 8, 9]);
    const wasmHash = await sha256Hex(wasm);
    const jsHash = await sha256Hex(js);
    const manifest = {
      driver: "gridlee",
      core_hash: wasmHash,
      mame_commit: "b".repeat(40),
      emsdk: "6.0.2",
      artifacts: { "mamegridlee.wasm": wasmHash, "mamegridlee.js": jsHash },
    };
    const writeFile = vi.fn();
    const loadScript = async () => {
      const mod = (globalThis as Record<string, unknown>).Module as TestModule;
      mod.FS = {
        mkdir: () => {},
        writeFile,
        readFile: () => new Uint8Array(),
        unlink: () => {},
      };
      mod.JSMAME = {
        save: () => {}, load: () => {}, soft_reset: () => {},
        hard_reset: () => {}, exit: () => {},
      };
      mod.HEAPU8 = new Uint8Array(0);
      mod._malloc = () => 0;
      mod._free = () => {};
      mod.preRun[0]?.();
      mod.onRuntimeInitialized();
    };

    const core = await loadBrowserCore(
      {
        coreBaseUrl: "https://x/cores/gridlee",
        romZipUrl: "https://x/roms/gridlee.zip",
        driver: "gridlee",
        args: ["gridlee", "-skip_gameinfo"],
        romPath: "/roms",
        romZipName: "gridlee.zip",
      },
      {
        fetchImpl: fakeFetch({
          "https://x/cores/gridlee/manifest.json": manifest,
          "https://x/cores/gridlee/mamegridlee.wasm": wasm,
          "https://x/cores/gridlee/mamegridlee.js": js,
          "https://x/roms/gridlee.zip": rom,
        }),
        loadScript,
      },
    );

    await expect(core.load()).resolves.toBeUndefined();
    expect(writeFile).toHaveBeenCalledWith("/roms/gridlee.zip", rom);
    expect(
      ((globalThis as Record<string, unknown>).Module as TestModule).arguments,
    ).toEqual(["gridlee", "-skip_gameinfo"]);
  });
});
