import { describe, expect, it } from "vitest";
import { appTitle } from "./main";

describe("appTitle", () => {
  it("returns the app name", () => {
    expect(appTitle()).toBe("Web MAME Arcade");
  });
});
