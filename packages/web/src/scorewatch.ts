/**
 * Dev-only scorewatch hook (T32b scoremap discovery). When the page is opened
 * with `?scorewatch=1`, it samples the emulated program RAM once per second and
 * POSTs each sample to the Vite dev server (`/__scorewatch`), which appends it
 * to /tmp/gridlee_ram.log on the dev host. That lets you play in a fast local
 * browser (real mouse/keyboard) while the RAM log lands server-side, instead of
 * driving MAME over a slow forwarded display.
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

export function installScoreWatch(
  win: Window,
  intervalMs = 1000,
): void {
  const params = new URLSearchParams(win.location.search);
  if (params.get("scorewatch") !== "1") return;

  let frame = 0;
  win.setInterval(() => {
    const module = (win as unknown as { Module?: ScorewatchModule }).Module;
    const readMemory = module?.netplay?.readMemory;
    if (!readMemory) return;
    try {
      const parts: string[] = [];
      for (let addr = 0; addr < 0x8000; addr += 64) {
        const chunk = readMemory(":maincpu", "program", addr, 64);
        for (let i = 0; i < chunk.length; i++) {
          parts.push((chunk[i] ?? 0).toString(16).padStart(2, "0"));
        }
      }
      frame += 60;
      const line = `RAM ${frame} ${parts.join("")}`;
      void fetch("/__scorewatch", { method: "POST", body: line }).catch(() => {});
      console.log(`[scorewatch] frame ${frame}`);
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
  console.info(`[scorewatch] logging program RAM every ${intervalMs}ms`);
}
