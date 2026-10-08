import { describe, expect, it } from "vitest";
import { serviceName } from "./index";

describe("verifier serviceName", () => {
  it("identifies the package", () => {
    expect(serviceName).toBe("@wma/verifier");
  });
});
