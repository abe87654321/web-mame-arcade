/**
 * Gunzip a stored artifact in the browser (T35). The relay stores closed input
 * logs as gzip of their UTF-8 JSON (docs/contracts/input-log.md); the replay
 * page inflates them before `decodeInputLog`. Uses the Web Streams
 * `DecompressionStream`, available in every target browser and in Node >= 18
 * (tests), so no dependency is needed.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into an ArrayBuffer-backed view: Blob rejects a possibly-shared
  // `Uint8Array<ArrayBufferLike>` (TS 5.7 lib) and the artifact is small.
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
