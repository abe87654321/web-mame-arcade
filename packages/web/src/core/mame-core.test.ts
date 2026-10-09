import { describe, expect, it, vi } from "vitest";
import { CoreCapabilityError } from "./errors";
import { MameCore } from "./mame-core";
import type { CoreModule, NetplayHooks } from "./module";

function fakeModule(netplay?: NetplayHooks): CoreModule {
  return {
    FS: { mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn(), unlink: vi.fn() },
    HEAPU8: new Uint8Array(0),
    _malloc: vi.fn(() => 0),
    _free: vi.fn(),
    JSMAME: {
      save: vi.fn(), load: vi.fn(), soft_reset: vi.fn(), hard_reset: vi.fn(), exit: vi.fn(),
    },
    ...(netplay ? { netplay } : {}),
  };
}

const options = { args: [], romPath: "/roms", romZipName: "gridlee.zip" };

describe("MameCore", () => {
  it("boots without native netplay support", async () => {
    await expect(new MameCore(fakeModule(), options).load()).resolves.toBeUndefined();
  });

  it("resets and destroys through JSMAME", () => {
    const mod = fakeModule();
    const core = new MameCore(mod, options);
    core.reset();
    core.destroy();
    expect(mod.JSMAME.soft_reset).toHaveBeenCalledOnce();
    expect(mod.JSMAME.exit).toHaveBeenCalledOnce();
  });

  it("throws CoreCapabilityError for step/save/hash/load(state) without T20", () => {
    const core = new MameCore(fakeModule(), options);
    expect(() => core.step(0, [0, 0, 0, 0])).toThrow(CoreCapabilityError);
    expect(() => core.save()).toThrow(CoreCapabilityError);
    expect(() => core.hash()).toThrow(CoreCapabilityError);
    expect(() => core.load(new Uint8Array([1]))).toThrow(CoreCapabilityError);
  });

  it("throws CoreCapabilityError for readScore until T32", () => {
    expect(() => new MameCore(fakeModule(), options).readScore()).toThrow(
      CoreCapabilityError,
    );
  });

  it("delegates to the netplay hooks when present", () => {
    const netplay: NetplayHooks = {
      enable: vi.fn(),
      setInputs: vi.fn(),
      saveState: vi.fn(() => new Uint8Array([1, 2])),
      loadState: vi.fn(),
      hash: vi.fn(() => 0xdeadbeef),
      step: vi.fn(),
    };
    const core = new MameCore(fakeModule(netplay), options);
    core.step(7, [1, 2, 3, 4]);
    expect(netplay.step).toHaveBeenCalledWith(7);
    expect(netplay.setInputs).toHaveBeenCalledWith(7, 1, 2, 3, 4);
    expect(core.save()).toEqual(new Uint8Array([1, 2]));
    expect(core.hash()).toBe(0xdeadbeef);
    core.load(new Uint8Array([5]));
    expect(netplay.loadState).toHaveBeenCalledWith(new Uint8Array([5]));
  });
});
