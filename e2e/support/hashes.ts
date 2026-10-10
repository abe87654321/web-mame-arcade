/**
 * Read the netplay desync signal straight off each tab's relay WebSocket (T26).
 * A seated player sends `{t:"hash",frame,crc32}` to the relay every 60 frames
 * (docs/03); the relay fans a `{t:"desync",frame}` back on a genuine mismatch.
 * Sniffing the socket keeps the harness free of any production/protocol change.
 */
import type { Page } from "@playwright/test";

interface HashFrame {
  t?: string;
  frame?: number;
  crc32?: number;
}

/** frame → crc32 for every `hash` frame this page sends to the relay. */
export function collectHashes(page: Page): Map<number, number> {
  const hashes = new Map<number, number>();
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      let message: HashFrame;
      try {
        message = JSON.parse(frame.payload) as HashFrame;
      } catch {
        return;
      }
      if (
        message.t === "hash" &&
        typeof message.frame === "number" &&
        typeof message.crc32 === "number"
      ) {
        hashes.set(message.frame, message.crc32);
      }
    });
  });
  return hashes;
}

/** Frames for which this page received a `desync` from the relay. */
export function desyncFrames(page: Page): number[] {
  const found: number[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      if (typeof frame.payload !== "string") return;
      try {
        const message = JSON.parse(frame.payload) as HashFrame;
        if (message.t === "desync" && typeof message.frame === "number") {
          found.push(message.frame);
        }
      } catch {
        return;
      }
    });
  });
  return found;
}
