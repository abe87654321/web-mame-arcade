import { describe, expect, it } from "vitest";
import { sha256Bytes, toHex } from "./sha256";
import { sha256Hex } from "./manifest";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Deterministic pseudo-random bytes (no Math.random in tests). */
function series(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff;
  return bytes;
}

describe("sha256Bytes", () => {
  it("matches the known FIPS vectors", () => {
    expect(toHex(sha256Bytes(enc("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(toHex(sha256Bytes(enc("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      toHex(
        sha256Bytes(
          enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        ),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("agrees with Web Crypto across block boundaries", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000]) {
      const bytes = series(length);
      expect(toHex(sha256Bytes(bytes)), `length ${length}`).toBe(
        await sha256Hex(bytes),
      );
    }
  });
});
