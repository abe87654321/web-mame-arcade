import { describe, expect, it } from "vitest";
import { serviceName } from "./index";

describe("api serviceName", () => {
  it("identifies the package", () => {
    expect(serviceName).toBe("@wma/api");
  });
});
