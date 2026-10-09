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
  onAbort?: (what: unknown) => void;
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
    // Mirror build-wasm.sh output: <driver>.js/.wasm, not mame<driver>.*.
    const manifest = {
      driver: "gridlee",
      core_hash: wasmHash,
      mame_commit: "b".repeat(40),
      emsdk: "6.0.2",
      artifacts: { "gridlee.wasm": wasmHash, "gridlee.js": jsHash },
    };
    const writeFile = vi.fn();
    let loadedUrl = "";
    const loadScript = async (url: string) => {
      loadedUrl = url;
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
          "https://x/cores/gridlee/gridlee.wasm": wasm,
          "https://x/cores/gridlee/gridlee.js": js,
          "https://x/roms/gridlee.zip": rom,
        }),
        loadScript,
      },
    );

    await expect(core.load()).resolves.toBeUndefined();
    expect(loadedUrl).toBe("https://x/cores/gridlee/gridlee.js");
    expect(writeFile).toHaveBeenCalledWith("/roms/gridlee.zip", rom);
    expect(
      ((globalThis as Record<string, unknown>).Module as TestModule).arguments,
    ).toEqual(["gridlee", "-skip_gameinfo"]);
  });

  it("arms the netplay gate at runtime init when requested", async () => {
    const wasm = new Uint8Array([1, 2, 3]);
    const js = new Uint8Array([4, 5]);
    const wasmHash = await sha256Hex(wasm);
    const jsHash = await sha256Hex(js);
    const manifest = {
      driver: "gridlee",
      core_hash: wasmHash,
      mame_commit: "b".repeat(40),
      emsdk: "6.0.2",
      artifacts: { "mamegridlee.wasm": wasmHash, "mamegridlee.js": jsHash },
    };
    const enable = vi.fn();
    const loadScript = async () => {
      const mod = (globalThis as Record<string, unknown>).Module as TestModule;
      mod.FS = {
        mkdir: () => {},
        writeFile: () => {},
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
      (mod as TestModule & { netplay?: { enable(): void } }).netplay = { enable };
      mod.preRun[0]?.();
      mod.onRuntimeInitialized();
    };

    await loadBrowserCore(
      {
        coreBaseUrl: "https://x/cores/gridlee",
        romZipUrl: "https://x/roms/gridlee.zip",
        driver: "gridlee",
        args: ["gridlee"],
        romPath: "/roms",
        romZipName: "gridlee.zip",
        netplay: true,
      },
      {
        fetchImpl: fakeFetch({
          "https://x/cores/gridlee/manifest.json": manifest,
          "https://x/cores/gridlee/mamegridlee.wasm": wasm,
          "https://x/cores/gridlee/mamegridlee.js": js,
          "https://x/roms/gridlee.zip": new Uint8Array([6]),
        }),
        loadScript,
      },
    );

    expect(enable).toHaveBeenCalledOnce();
  });

  it("rejects when the runtime aborts instead of hanging", async () => {
    const wasm = new Uint8Array([1, 2, 3]);
    const js = new Uint8Array([4, 5]);
    const wasmHash = await sha256Hex(wasm);
    const jsHash = await sha256Hex(js);
    const manifest = {
      driver: "gridlee",
      core_hash: wasmHash,
      mame_commit: "b".repeat(40),
      emsdk: "6.0.2",
      artifacts: { "mamegridlee.wasm": wasmHash, "mamegridlee.js": jsHash },
    };
    const loadScript = async () => {
      const mod = (globalThis as Record<string, unknown>).Module as TestModule;
      mod.onAbort?.("out of memory");
    };

    await expect(
      loadBrowserCore(
        {
          coreBaseUrl: "https://x/cores/gridlee",
          romZipUrl: "https://x/roms/gridlee.zip",
          driver: "gridlee",
          args: ["gridlee"],
          romPath: "/roms",
          romZipName: "gridlee.zip",
        },
        {
          fetchImpl: fakeFetch({
            "https://x/cores/gridlee/manifest.json": manifest,
            "https://x/cores/gridlee/mamegridlee.wasm": wasm,
            "https://x/cores/gridlee/mamegridlee.js": js,
            "https://x/roms/gridlee.zip": new Uint8Array([6]),
          }),
          loadScript,
        },
      ),
    ).rejects.toThrow(/aborted/);
  });
});
