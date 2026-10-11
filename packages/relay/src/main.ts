/**
 * Relay entrypoint. Run with Node's native type stripping:
 *   WMA_RELAY_SECRET=dev pnpm --filter @wma/relay start
 */
import { createRelayServer } from "./server.ts";
import { createHs256Verifier } from "./token.ts";
import type { LivekitConfig } from "./livekit.ts";

const secret = process.env.WMA_RELAY_SECRET;
if (!secret) {
  console.error("WMA_RELAY_SECRET is required");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const verifier = createHs256Verifier(secret);

// Optional LiveKit A/V fallback (T41): enabled only when all three are set, so
// a relay without LiveKit simply rejects `video.set` with `unsupported`.
const livekitUrl = process.env.LIVEKIT_URL;
const livekitApiKey = process.env.LIVEKIT_API_KEY;
const livekitApiSecret = process.env.LIVEKIT_API_SECRET;
const livekit: LivekitConfig | undefined =
  livekitUrl && livekitApiKey && livekitApiSecret
    ? {
        url: livekitUrl,
        apiKey: livekitApiKey,
        apiSecret: livekitApiSecret,
        ...(process.env.LIVEKIT_TTL_SEC
          ? { ttlSec: Number(process.env.LIVEKIT_TTL_SEC) }
          : {}),
      }
    : undefined;

const server = await createRelayServer({ verifier, port, host, livekit });
console.log(`relay listening on ws://${host}:${server.port}/ws`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
