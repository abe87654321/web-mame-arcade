import type { CoreModule } from "./module";

/**
 * Mount a ROM zip at `<romPath>/<romZipName>` so MAME finds it under -rompath.
 * Emscripten's FS.mkdir is not recursive, so create each segment; mkdir and
 * unlink throw when the path already exists, which is fine to ignore.
 */
export function mountRom(
  module: CoreModule,
  romPath: string,
  romZipName: string,
  zip: Uint8Array,
): void {
  for (const dir of pathSegments(romPath)) {
    try {
      module.FS.mkdir(dir);
    } catch {
      // Directory already exists.
    }
  }
  const file = `${romPath}/${romZipName}`;
  try {
    module.FS.unlink(file);
  } catch {
    // No previous file.
  }
  module.FS.writeFile(file, zip);
}

function pathSegments(path: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const part of path.split("/")) {
    if (part.length === 0) continue;
    current += `/${part}`;
    out.push(current);
  }
  return out;
}
