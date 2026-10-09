import { describe, expect, it } from "vitest";
import { CoreCapabilityError } from "./errors";

describe("CoreCapabilityError", () => {
  it("names the method and the task that provides it", () => {
    const err = new CoreCapabilityError("hash", "T20");
    expect(err.name).toBe("CoreCapabilityError");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("hash");
    expect(err.message).toContain("T20");
  });
});
