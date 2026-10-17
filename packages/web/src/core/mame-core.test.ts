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
    expect(() => core.load(new Uint8Array([1]), 42)).toThrow(CoreCapabilityError);
  });

  it("throws CoreCapabilityError for readScore until T32b", () => {
    expect(() => new MameCore(fakeModule(), options).readScore(0)).toThrow(
      CoreCapabilityError,
    );
  });

  it("decodes readScore through the scoremap and the native read", () => {
    const netplay = {
      enable: vi.fn(),
      setInputs: vi.fn(),
      saveState: vi.fn(),
      loadState: vi.fn(),
      setFrame: vi.fn(),
      hash: vi.fn(),
      step: vi.fn(),
      readMemory: vi.fn(() => new Uint8Array([0x45, 0x23, 0x01])),
    } as unknown as NetplayHooks;
    const core = new MameCore(fakeModule(netplay), {
      ...options,
      score: {
        v: 1,
        players: [
          {
            slot: 0,
            cpu: ":maincpu",
            space: "program",
            addr: "0x4e80",
            len: 3,
            format: "bcd",
          },
        ],
      },
    });
    expect(core.readScore(0)).toBe(12345);
    expect(netplay.readMemory).toHaveBeenCalledWith(":maincpu", "program", 0x4e80, 3);
  });

  it("throws for a slot with no scoremap entry", () => {
    const netplay = {
      enable: vi.fn(),
      setInputs: vi.fn(),
      saveState: vi.fn(),
      loadState: vi.fn(),
      setFrame: vi.fn(),
      hash: vi.fn(),
      step: vi.fn(),
      readMemory: vi.fn(),
    } as unknown as NetplayHooks;
    const core = new MameCore(fakeModule(netplay), {
      ...options,
      score: { v: 1, players: [] },
    });
    expect(() => core.readScore(0)).toThrow(CoreCapabilityError);
  });

  it("throws when the core build lacks the read hook", () => {
    const netplay = {
      enable: vi.fn(),
      setInputs: vi.fn(),
      saveState: vi.fn(),
      loadState: vi.fn(),
      setFrame: vi.fn(),
      hash: vi.fn(),
      step: vi.fn(),
    } as unknown as NetplayHooks;
    const core = new MameCore(fakeModule(netplay), {
      ...options,
      score: {
        v: 1,
        players: [
          { slot: 0, cpu: ":maincpu", space: "program", addr: "0x10", len: 1, format: "binary" },
        ],
      },
    });
    expect(() => core.readScore(0)).toThrow(CoreCapabilityError);
  });

  it("delegates to the netplay hooks when present", () => {
    const netplay: NetplayHooks = {
      enable: vi.fn(),
      setInputs: vi.fn(),
      saveState: vi.fn(() => new Uint8Array([1, 2])),
      loadState: vi.fn(),
      setFrame: vi.fn(),
      hash: vi.fn(() => 0xdeadbeef),
      step: vi.fn(),
      readMemory: vi.fn(() => new Uint8Array()),
      setSilent: vi.fn(),
      renderNow: vi.fn(),
    };
    const core = new MameCore(fakeModule(netplay), options);
    core.step(7, [1, 2, 3, 4]);
    expect(netplay.step).toHaveBeenCalledWith(7);
    expect(netplay.setInputs).toHaveBeenCalledWith(7, 1, 2, 3, 4);
    expect(core.save()).toEqual(new Uint8Array([1, 2]));
    expect(core.hash()).toBe(0xdeadbeef);
    core.load(new Uint8Array([5]), 42);
    expect(netplay.loadState).toHaveBeenCalledWith(new Uint8Array([5]));
    expect(netplay.setFrame).toHaveBeenCalledWith(42);
    core.setSilent?.(true);
    expect(netplay.setSilent).toHaveBeenCalledWith(true);
    core.renderNow?.();
    expect(netplay.renderNow).toHaveBeenCalled();
  });

  it("loads a boot snapshot labelled startFrame - 1", () => {
    const netplay: NetplayHooks = {
      enable: vi.fn(),
      setInputs: vi.fn(),
      saveState: vi.fn(),
      loadState: vi.fn(),
      setFrame: vi.fn(),
      hash: vi.fn(),
      step: vi.fn(),
      readMemory: vi.fn(() => new Uint8Array()),
    };
    const core = new MameCore(fakeModule(netplay), options);
    core.load(new Uint8Array([5]), -1);
    expect(netplay.loadState).toHaveBeenCalledWith(new Uint8Array([5]));
    // netplay_set_frame takes a uint32 and computes frame + 1; 0xffffffff wraps
    // to 0, so rollback can re-step frame 0 (T40).
    expect(netplay.setFrame).toHaveBeenCalledWith(0xffffffff);
  });

  it("throws when a pre-T25 core is asked to load with a frame", () => {
    const netplay = {
      enable: vi.fn(),
      setInputs: vi.fn(),
      saveState: vi.fn(),
      loadState: vi.fn(),
      hash: vi.fn(),
      step: vi.fn(),
    } as unknown as NetplayHooks;
    const core = new MameCore(fakeModule(netplay), options);
    expect(() => core.load(new Uint8Array([1]), 60)).toThrow(CoreCapabilityError);
  });
});
