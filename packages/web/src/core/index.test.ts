import { describe, expect, it } from "vitest";
import * as core from "./index";

describe("core public surface", () => {
  it("exports the loader, wrapper, verifier and helpers", () => {
    expect(typeof core.loadBrowserCore).toBe("function");
    expect(typeof core.loadCoreBundle).toBe("function");
    expect(typeof core.MameCore).toBe("function");
    expect(typeof core.mountRom).toBe("function");
    expect(typeof core.buildMameArgs).toBe("function");
    expect(typeof core.parseManifest).toBe("function");
  });
});
