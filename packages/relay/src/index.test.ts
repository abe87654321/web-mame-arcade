import { describe, expect, it } from "vitest";
import { serviceName } from "./index";

describe("relay serviceName", () => {
  it("identifies the package", () => {
    expect(serviceName).toBe("@wma/relay");
  });
});
