/**
 * Relay entrypoint. Run with Node's native type stripping:
 *   node packages/relay/src/main.ts
 * Full server wiring lands with the ws binding.
 */
import { PROTOCOL_VERSION } from "@wma/protocol";
import { serviceName } from "./index.ts";

console.log(`${serviceName} starting (protocol v${PROTOCOL_VERSION})`);
