/**
 * Read closed input-log artifacts from local disk for `GET /api/replays/:key`
 * (T34). The relay writes logs under `WMA_LOG_DIR` (docs/06); this serves them
 * back. A MinIO/S3 backend (T42) would replace this behind the same route.
 */
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** The key is missing, not a file, or escapes the log directory. */
export class ReplayNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayNotFound";
  }
}

/**
 * Read the gzip(JSON) artifact for `key` under `logDir`. Keys are relay-generated
 * (`match/<room>/<id>.json.gz`) but the resolved path is still constrained to
 * `logDir` so a crafted key cannot read outside it.
 */
export async function readReplay(logDir: string, key: string): Promise<Uint8Array> {
  const root = resolve(logDir);
  const target = resolve(root, key);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new ReplayNotFound(`replay key escapes the log directory: ${key}`);
  }
  try {
    return new Uint8Array(await readFile(target));
  } catch {
    throw new ReplayNotFound(`no replay for key: ${key}`);
  }
}
