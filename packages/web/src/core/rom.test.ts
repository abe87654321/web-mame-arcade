import { describe, expect, it, vi } from "vitest";
import type { CoreModule, EmscriptenFS } from "./module";
import { mountRom } from "./rom";

function fakeFs() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const FS: EmscriptenFS = {
    mkdir: (p) => { dirs.add(p); },
    writeFile: (p, d) => { files.set(p, d); },
    readFile: (p) => {
      const d = files.get(p);
      if (!d) throw new Error("ENOENT");
      return d;
    },
    unlink: (p) => { if (!files.delete(p)) throw new Error("ENOENT"); },
  };
  return { FS, files, dirs };
}

function fakeModule(FS: EmscriptenFS): CoreModule {
  return {
    FS,
    HEAPU8: new Uint8Array(0),
    _malloc: () => 0,
    _free: () => {},
    JSMAME: {
      save: vi.fn(), load: vi.fn(), soft_reset: vi.fn(), hard_reset: vi.fn(), exit: vi.fn(),
    },
  };
}

describe("mountRom", () => {
  it("creates the parent dir and writes the zip at romPath/romZipName", () => {
    const { FS, files, dirs } = fakeFs();
    const zip = new Uint8Array([1, 2, 3]);
    mountRom(fakeModule(FS), "/roms", "gridlee.zip", zip);
    expect(dirs.has("/roms")).toBe(true);
    expect(files.get("/roms/gridlee.zip")).toEqual(zip);
  });

  it("overwrites an existing zip", () => {
    const { FS, files } = fakeFs();
    files.set("/roms/gridlee.zip", new Uint8Array([9]));
    mountRom(fakeModule(FS), "/roms", "gridlee.zip", new Uint8Array([7]));
    expect(files.get("/roms/gridlee.zip")).toEqual(new Uint8Array([7]));
  });

  it("ignores an already-existing directory", () => {
    const { FS } = fakeFs();
    FS.mkdir = () => { throw new Error("EEXIST"); };
    expect(() =>
      mountRom(fakeModule(FS), "/roms", "gridlee.zip", new Uint8Array()),
    ).not.toThrow();
  });
});
