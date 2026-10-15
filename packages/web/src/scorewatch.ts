/**
 * Dev-only scorewatch hook (T32b/T47 scoremap discovery). When the page is
 * opened with `?scorewatch=1`, it samples an emulated memory window once per
 * second and POSTs each sample to the Vite dev server (`/__scorewatch`), which
 * appends it to /tmp/gridlee_ram.log on the dev host; screen captures every 5 s
 * land in /tmp/snaps/<frame>.png. Playing in the browser and then correlating
 * the on-screen score (from the shots) with the RAM columns is the most reliable
 * way to find a score cell — no interactive cheat search needed.
 *
 * The window is configurable so it works for any driver (default gridlee's
 * program RAM):
 *   ?scorewatch=1&base=0x30000&size=0x4000&cpu=:maincpu&space=program
 *
 * Inert unless the query param is present; never included in production builds.
 */

interface ScorewatchModule {
  netplay?: {
    readMemory?: (
      cpu: string,
      space: string,
      addr: number,
      len: number,
    ) => Uint8Array;
  };
}

function parseHex(raw: string | null, fallback: number): number {
  if (raw === null || raw === "") return fallback;
  const value = raw.startsWith("0x")
    ? Number.parseInt(raw.slice(2), 16)
    : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

export function installScoreWatch(win: Window, intervalMs = 1000): void {
  const params = new URLSearchParams(win.location.search);
  if (params.get("scorewatch") !== "1") return;

  const cpu = params.get("cpu") ?? ":maincpu";
  const space = params.get("space") ?? "program";
  const base = parseHex(params.get("base"), 0x0000);
  const size = parseHex(params.get("size"), 0x8000);

  let frame = 0;
  win.setInterval(() => {
    const module = (win as unknown as { Module?: ScorewatchModule }).Module;
    const readMemory = module?.netplay?.readMemory;
    if (!readMemory) return;
    try {
      const parts: string[] = [];
      for (let addr = base; addr < base + size; addr += 64) {
        const len = Math.min(64, base + size - addr);
        let chunk: Uint8Array;
        try {
          chunk = readMemory(cpu, space, addr, len);
        } catch {
          chunk = new Uint8Array(len).fill(0xff); // handler-mapped hole
        }
        for (let i = 0; i < chunk.length; i++) {
          parts.push((chunk[i] ?? 0).toString(16).padStart(2, "0"));
        }
      }
      frame += 60;
      const line =
        `RAM ${frame} ${cpu} ${space} 0x${base.toString(16)} ${parts.join("")}`;
      void fetch("/__scorewatch", { method: "POST", body: line }).catch(() => {});
      console.log(`[scorewatch] frame ${frame} ${cpu}/${space} 0x${base.toString(16)}`);
    } catch {
      // A transient read failure must not disturb the game.
    }
  }, intervalMs);

  // Screen captures must run inside requestAnimationFrame, right after MAME
  // draws but before the browser composites and clears the WebGL drawing buffer
  // (a setInterval capture returns a blank canvas).
  let lastShot = 0;
  const capture = (): void => {
    const now = win.performance.now();
    if (now - lastShot >= 5000 && frame > 0) {
      lastShot = now;
      const canvas = win.document.querySelector(
        "#canvas",
      ) as HTMLCanvasElement | null;
      if (canvas && canvas.width > 0) {
        try {
          const png = canvas.toDataURL("image/png");
          if (png.length > 2000) {
            void fetch(`/__shot/${frame}`, { method: "POST", body: png }).catch(
              () => {},
            );
          }
        } catch {
          // Ignore a failed capture.
        }
      }
    }
    win.requestAnimationFrame(capture);
  };
  win.requestAnimationFrame(capture);
  console.info(
    `[scorewatch] logging ${cpu}/${space} 0x${base.toString(16)}+0x${size.toString(16)} every ${intervalMs}ms`,
  );
}
