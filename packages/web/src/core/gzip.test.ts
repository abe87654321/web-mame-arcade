import { describe, expect, it } from "vitest";
import { gunzip } from "./gzip";

/** gzip of the UTF-8 bytes of "hello replay" (independently produced). */
const HELLO_GZIP_BASE64 = "H4sIAAAAAAAAA8tIzcnJVyhKLchJrAQAd64HqwwAAAA=";

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

describe("gunzip", () => {
  it("inflates a gzip artifact to its original bytes", async () => {
    const out = await gunzip(fromBase64(HELLO_GZIP_BASE64));
    expect(new TextDecoder().decode(out)).toBe("hello replay");
  });

  it("inflates an empty payload", async () => {
    // gzip of zero bytes.
    const empty = await gunzip(fromBase64("H4sIAAAAAAAAAwMAAAAAAAAAAAA="));
    expect(empty).toEqual(new Uint8Array());
  });

  it("rejects bytes that are not gzip", async () => {
    await expect(gunzip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});
