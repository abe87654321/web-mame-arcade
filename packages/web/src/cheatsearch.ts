/**
 * Dev-only browser cheat search (T47 scoremap discovery). When the play page is
 * opened with `?cheatsearch=1`, a small panel lets you converge on the RAM cell
 * that tracks the on-screen score — the same workflow as MAME's Cheat Search,
 * but running in the browser off the WASM core's `readMemory` hook (T32b), so it
 * works when the native MAME UI is hard to reach (e.g. a remote/thin client).
 *
 * This file holds the pure search state machine (`CheatSearch`), unit-tested
 * without a browser, plus the thin DOM panel. Inert unless the query param is
 * present and never included in production builds.
 */
import { decodeScore } from "./core/scoremap";

export type ScoreFormat = "bcd" | "binary";
export type ScoreEndian = "little" | "big";

export interface DecodeOptions {
  len: number;
  format: ScoreFormat;
  endian: ScoreEndian;
}

/** A RAM window; `bytes[i]` is the value at `base + i`, or -1 if unreadable. */
export interface Snapshot {
  base: number;
  bytes: Int16Array;
}

export interface Candidate {
  addr: number;
  value: number;
}

/**
 * Narrowing state machine. `snapshot` seeds the candidate set with every
 * readable byte; each `filter*` keeps only the bytes matching a predicate.
 * `changed/unchanged/increased/decreased` compare against the previous committed
 * snapshot, so call `commit()` once per "search again" step.
 */
export class CheatSearch {
  private baseAddr = 0;
  private bytes: Int16Array = new Int16Array(0);
  private prev: Int16Array | null = null;
  private cand: number[] = [];

  get base(): number {
    return this.baseAddr;
  }

  get count(): number {
    return this.cand.length;
  }

  /** Reset the search to every readable byte in `snap`. */
  snapshot(snap: Snapshot): void {
    this.baseAddr = snap.base;
    this.bytes = snap.bytes;
    this.prev = snap.bytes.slice();
    this.cand = [];
    for (let i = 0; i < snap.bytes.length; i++) {
      if (snap.bytes[i] !== undefined && snap.bytes[i]! >= 0) this.cand.push(i);
    }
  }

  /** Replace the current values (keep the candidate set). */
  update(snap: Snapshot): void {
    this.baseAddr = snap.base;
    this.bytes = snap.bytes;
  }

  /** Remember the current values as the baseline for the next comparison. */
  commit(): void {
    this.prev = this.bytes.slice();
  }

  filterEqual(value: number): void {
    this.cand = this.cand.filter((i) => this.bytes[i] === value);
  }

  filterChanged(): void {
    const prev = this.prev;
    if (!prev) return;
    this.cand = this.cand.filter(
      (i) => prev[i]! >= 0 && this.bytes[i]! >= 0 && this.bytes[i] !== prev[i],
    );
  }

  filterUnchanged(): void {
    const prev = this.prev;
    if (!prev) return;
    this.cand = this.cand.filter(
      (i) => prev[i]! >= 0 && this.bytes[i]! >= 0 && this.bytes[i] === prev[i],
    );
  }

  filterIncreased(): void {
    const prev = this.prev;
    if (!prev) return;
    this.cand = this.cand.filter(
      (i) => prev[i]! >= 0 && this.bytes[i]! >= 0 && this.bytes[i]! > prev[i]!,
    );
  }

  filterDecreased(): void {
    const prev = this.prev;
    if (!prev) return;
    this.cand = this.cand.filter(
      (i) => prev[i]! >= 0 && this.bytes[i]! >= 0 && this.bytes[i]! < prev[i]!,
    );
  }

  /**
   * Keep candidates whose `len`-byte window (read at the candidate address)
   * decodes to `target` under `opts`. This is what pins down `len/format/endian`
   * at once: the true score cell survives, other bytes rarely do.
   */
  filterEqualDecoded(target: number, opts: DecodeOptions): void {
    this.cand = this.cand.filter((i) => {
      const bytes = new Uint8Array(opts.len);
      for (let k = 0; k < opts.len; k++) {
        const v = this.bytes[i + k];
        if (v === undefined || v < 0) return false;
        bytes[k] = v;
      }
      try {
        return decodeScore(bytes, opts) === target;
      } catch {
        return false;
      }
    });
  }

  /** The first `limit` surviving candidates, as absolute addresses. */
  list(limit = 16): Candidate[] {
    return this.cand.slice(0, limit).map((i) => ({
      addr: this.baseAddr + i,
      value: this.bytes[i]!,
    }));
  }

  /** `len` bytes at a surviving candidate (or null if any is unreadable). */
  bytesAt(addr: number, len: number): Uint8Array | null {
    const start = addr - this.baseAddr;
    const out = new Uint8Array(len);
    for (let k = 0; k < len; k++) {
      const v = this.bytes[start + k];
      if (v === undefined || v < 0) return null;
      out[k] = v;
    }
    return out;
  }
}

interface ReadMemory {
  (cpu: string, space: string, addr: number, len: number): Uint8Array;
}

interface NetplayModuleHost {
  Module?: { netplay?: { readMemory?: ReadMemory } };
}

/** One decode interpretation and how many addresses in a snapshot match it. */
export interface ComboResult {
  len: number;
  /** `digits` = one decimal digit per byte (unpacked BCD). */
  format: ScoreFormat | "digits";
  endian: ScoreEndian;
  count: number;
  samples: number[];
}

/**
 * Scan the whole snapshot for every interpretation that decodes to `target`,
 * returning the number of matching addresses (and a few samples) for each. This
 * is how to find the score's encoding without guessing: the true combination
 * shows a small, plausible count where the others show 0 (or almost everything).
 *
 * Interpretations tried: packed `bcd`/`binary` for len 1-4, plus unpacked
 * decimal (`digits`, one digit per byte) — many arcade games store a score that
 * way.
 */
export function scanDecodeCombos(
  snap: Snapshot,
  target: number,
  lens: readonly number[] = [1, 2, 3, 4],
): ComboResult[] {
  const out: ComboResult[] = [];
  const window = (i: number, len: number, max: number): Uint8Array | null => {
    const bytes = new Uint8Array(len);
    for (let k = 0; k < len; k++) {
      const v = snap.bytes[i + k];
      if (v === undefined || v < 0 || v > max) return null;
      bytes[k] = v;
    }
    return bytes;
  };
  const ordered = (bytes: Uint8Array, endian: ScoreEndian): Uint8Array =>
    endian === "big" ? bytes : Uint8Array.from(bytes).reverse();

  for (const len of lens) {
    for (const endian of ["little", "big"] as const) {
      // Unpacked decimal: each byte is one digit (0-9).
      const digits: number[] = [];
      for (let i = 0; i + len <= snap.bytes.length; i++) {
        const bytes = window(i, len, 9);
        if (!bytes) continue;
        const value = Number(Array.from(ordered(bytes, endian)).join(""));
        if (value === target) {
          digits.push(snap.base + i);
        }
      }
      out.push({ len, format: "digits", endian, count: digits.length, samples: digits.slice(0, 8) });
    }

    for (const format of ["bcd", "binary"] as const) {
      for (const endian of ["little", "big"] as const) {
        let count = 0;
        const samples: number[] = [];
        for (let i = 0; i + len <= snap.bytes.length; i++) {
          const bytes = window(i, len, 255);
          if (!bytes) continue;
          let value: number;
          try {
            value = decodeScore(bytes, { len, format, endian });
          } catch {
            continue;
          }
          if (value === target) {
            count += 1;
            if (samples.length < 8) samples.push(snap.base + i);
          }
        }
        out.push({ len, format, endian, count, samples });
      }
    }
  }
  return out;
}

function tryRead(
  read: ReadMemory,
  cpu: string,
  space: string,
  addr: number,
  len: number,
): number[] | null {
  try {
    const bytes = read(cpu, space, addr, len);
    if (bytes && bytes.length === len) return Array.from(bytes);
  } catch {
    // handler-mapped / unmapped: fall through to a finer read
  }
  return null;
}

/** Read a window, bisecting around unreadable (handler-mapped) holes. */
function readInto(
  read: ReadMemory,
  cpu: string,
  space: string,
  addr: number,
  len: number,
  out: Int16Array,
  base: number,
  minBlock: number,
  budget: { n: number },
): void {
  if (budget.n <= 0) return;
  budget.n -= 1;
  const whole = tryRead(read, cpu, space, addr, len);
  if (whole) {
    for (let i = 0; i < len; i++) out[addr - base + i] = whole[i]!;
    return;
  }
  // Don't descend past `minBlock`: a below-block hole is skipped rather than
  // probed byte-by-byte, so a mostly-unmapped address space (e.g. a 256 KB
  // program window) cannot flood the page with hundreds of thousands of reads.
  if (len <= minBlock) return;
  const half = len >> 1;
  readInto(read, cpu, space, addr, half, out, base, minBlock, budget);
  readInto(read, cpu, space, addr + half, len - half, out, base, minBlock, budget);
}

/**
 * Read `[base, base+size)` of a CPU's address space; -1 marks unreadable.
 * `minBlock` bounds the bisection resolution and `maxProbes` caps total reads,
 * so a large or sparse window stays fast (a finer read only where RAM exists).
 */
export function readRegion(
  win: Window,
  cpu: string,
  space: string,
  base: number,
  size: number,
  chunk = 0x1000,
  minBlock = 0x40,
  maxProbes = 60_000,
): Snapshot {
  const out = new Int16Array(size).fill(-1);
  const read = (win as unknown as NetplayModuleHost).Module?.netplay?.readMemory;
  if (typeof read !== "function") return { base, bytes: out };
  const budget = { n: maxProbes };
  for (let off = 0; off < size; off += chunk) {
    if (budget.n <= 0) break;
    const len = Math.min(chunk, size - off);
    readInto(read, cpu, space, base + off, len, out, base, minBlock, budget);
  }
  return { base, bytes: out };
}

function hex(n: number, width = 4): string {
  return `0x${n.toString(16).padStart(width, "0")}`;
}

function parseNum(raw: string | null, fallback: number): number {
  if (raw === null || raw === "") return fallback;
  const value = raw.startsWith("0x")
    ? Number.parseInt(raw.slice(2), 16)
    : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Install the cheat-search panel when `?cheatsearch=1` is present. Reads the
 * window/CPU from the query so one driver can be searched at a time, e.g.
 * `?cheatsearch=1&driver=twinbee&base=0x1e000&size=0x2000`.
 */
export function installCheatSearch(win: Window): void {
  const params = new URLSearchParams(win.location.search);
  if (params.get("cheatsearch") !== "1") return;

  const cpu = params.get("cpu") ?? ":maincpu";
  const space = params.get("space") ?? "program";
  const base = parseNum(params.get("base"), 0x0000);
  const size = parseNum(params.get("size"), 0x10000);
  const slotDefault = parseNum(params.get("slot"), 0);

  const search = new CheatSearch();
  const doc = win.document;

  const panel = doc.createElement("div");
  panel.setAttribute("data-wma-cheatsearch", "1");
  panel.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:99999;width:340px;max-height:90vh;" +
    "overflow:auto;background:#111c;color:#eee;font:12px/1.4 monospace;" +
    "padding:8px;border:1px solid #666;border-radius:6px;backdrop-filter:blur(2px)";

  const title = doc.createElement("div");
  title.textContent = `cheat search ${cpu}/${space} ${hex(base, 5)}..${hex(base + size, 5)}`;
  panel.appendChild(title);

  const row = (): HTMLDivElement => {
    const d = doc.createElement("div");
    d.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;margin:4px 0";
    return d;
  };
  const button = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.textContent = label;
    b.onclick = onClick;
    return b;
  };
  const status = doc.createElement("div");
  status.style.cssText = "margin:6px 0;white-space:pre-wrap";

  const results = doc.createElement("div");
  results.style.cssText = "max-height:38vh;overflow:auto;white-space:pre";

  const read = (): Snapshot => readRegion(win, cpu, space, base, size);
  const show = (): void => {
    status.textContent = `candidates: ${search.count}`;
    results.textContent = search
      .list(24)
      .map((c) => {
        const bytes = search.bytesAt(c.addr, 4);
        const hexBytes = bytes
          ? Array.from(bytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ")
          : "??";
        return `${hex(c.addr, 5)}  = ${String(c.value).padStart(3)}  [${hexBytes}]`;
      })
      .join("\n");
  };

  panel.appendChild(
    (() => {
      const r = row();
      r.appendChild(button("Reset (score 0)", () => { search.snapshot(read()); show(); }));
      r.appendChild(button("Changed", () => { search.update(read()); search.filterChanged(); search.commit(); show(); }));
      r.appendChild(button("Unchanged", () => { search.update(read()); search.filterUnchanged(); search.commit(); show(); }));
      r.appendChild(button("Increased", () => { search.update(read()); search.filterIncreased(); search.commit(); show(); }));
      r.appendChild(button("Decreased", () => { search.update(read()); search.filterDecreased(); search.commit(); show(); }));
      return r;
    })(),
  );

  // Pause the emulation so the score can be read and typed without it moving.
  // The engine's main loop is driven by emscripten; pauseMainLoop/resumeMainLoop
  // freeze it without touching the machine (a RAM read still works while paused).
  const runtime = win as unknown as {
    Module?: { pauseMainLoop?: () => void; resumeMainLoop?: () => void };
  };
  let paused = false;
  panel.appendChild(
    (() => {
      const r = row();
      const pauseBtn = button("Pause game", () => {
        if (paused) {
          runtime.Module?.resumeMainLoop?.();
          paused = false;
        } else {
          runtime.Module?.pauseMainLoop?.();
          paused = true;
        }
        pauseBtn.textContent = paused ? "Resume game" : "Pause game";
      });
      r.appendChild(pauseBtn);
      r.appendChild(
        doc.createTextNode("pause, read the score, then Filter"),
      );
      return r;
    })(),
  );

  const lenInput = doc.createElement("input");
  lenInput.value = "3";
  lenInput.style.width = "36px";
  const fmtSelect = doc.createElement("select");
  for (const f of ["bcd", "binary"]) {
    const o = doc.createElement("option");
    o.value = f;
    o.textContent = f;
    fmtSelect.appendChild(o);
  }
  const endianSelect = doc.createElement("select");
  for (const e of ["little", "big"]) {
    const o = doc.createElement("option");
    o.value = e;
    o.textContent = e;
    endianSelect.appendChild(o);
  }
  const scoreInput = doc.createElement("input");
  scoreInput.placeholder = "score";
  scoreInput.style.width = "72px";

  panel.appendChild(
    (() => {
      const r = row();
      r.appendChild(doc.createTextNode("= score"));
      r.appendChild(scoreInput);
      r.appendChild(doc.createTextNode("len"));
      r.appendChild(lenInput);
      r.appendChild(fmtSelect);
      r.appendChild(endianSelect);
      r.appendChild(
        button("Filter", () => {
          const target = Number.parseInt(scoreInput.value, 10);
          if (!Number.isFinite(target)) return;
          search.update(read());
          search.filterEqualDecoded(target, {
            len: parseNum(lenInput.value, 3),
            format: fmtSelect.value as ScoreFormat,
            endian: endianSelect.value as ScoreEndian,
          });
          search.commit();
          show();
        }),
      );
      // Try every len/format/endian (packed and unpacked) for the score and its
      // common ×10/×100 scalings, listing which ones match — so the encoding can
      // be found instead of guessed (a wrong guess filters to 0).
      r.appendChild(
        button("Scan decode", () => {
          const base0 = Number.parseInt(scoreInput.value, 10);
          if (!Number.isFinite(base0)) return;
          const snap = read();
          const lines: string[] = [];
          for (const mul of [1, 10, 100]) {
            const target = base0 * mul;
            const label = mul === 1 ? "" : ` (×${mul})`;
            for (const c of scanDecodeCombos(snap, target)) {
              if (c.count === 0) continue;
              lines.push(
                `${target}${label}: len ${c.len} ${c.format.padEnd(6)} ${c.endian.padEnd(6)} count=${c.count}  ` +
                  c.samples
                    .slice(0, 4)
                    .map((a) => hex(a, 5))
                    .join(" "),
              );
            }
          }
          results.textContent = lines.length
            ? lines.join("\n")
            : `no address in range decodes to ${base0} (×1/×10/×100) — widen base/size or try the low RAM range`;
        }),
      );
      return r;
    })(),
  );

  const appendScore = (text: string): void => {
    scoreInput.value += text;
  };
  // On-screen keypad: the game's SDL keyboard capture swallows typed keys and
  // clipboard paste, so entering the score must not depend on them.
  panel.appendChild(
    (() => {
      const r = row();
      for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]) {
        r.appendChild(button(key, () => appendScore(key)));
      }
      r.appendChild(button("<", () => { scoreInput.value = scoreInput.value.slice(0, -1); }));
      r.appendChild(button("C", () => { scoreInput.value = ""; }));
      return r;
    })(),
  );

  // Shield the panel's own keys from the game's document/window handlers.
  for (const type of ["keydown", "keyup", "keypress"] as const) {
    panel.addEventListener(type, (event) => event.stopPropagation());
  }

  panel.appendChild(
    (() => {
      const r = row();
      const slotInput = doc.createElement("input");
      slotInput.value = String(slotDefault);
      slotInput.style.width = "36px";
      r.appendChild(doc.createTextNode("entry slot"));
      r.appendChild(slotInput);
      r.appendChild(
        button("Print JSON entry", () => {
          const c = search.list(1)[0];
          if (!c) return;
          const entry = {
            slot: parseNum(slotInput.value, 0),
            cpu,
            space,
            addr: hex(c.addr, 5),
            len: parseNum(lenInput.value, 3),
            format: fmtSelect.value,
            endian: endianSelect.value,
          };
          const text = JSON.stringify(entry);
          console.info("[cheatsearch] candidate", c, text);
          try {
            void win.navigator.clipboard?.writeText(text);
          } catch {
            /* clipboard may be unavailable */
          }
        }),
      );
      return r;
    })(),
  );

  const close = row();
  close.appendChild(button("Hide panel", () => panel.remove()));
  panel.appendChild(close);

  panel.appendChild(status);
  panel.appendChild(results);
  doc.body.appendChild(panel);

  // The SDL3 backend runs the game canvas in the Fullscreen API, which puts it
  // in the CSS top layer — above any z-index — so a body overlay can never be
  // clicked while fullscreen. Leave fullscreen now and whenever it is re-entered
  // so the panel stays clickable.
  const leaveFullscreen = (): void => {
    if (doc.fullscreenElement && typeof doc.exitFullscreen === "function") {
      void doc.exitFullscreen().catch(() => {});
    }
  };
  leaveFullscreen();
  doc.addEventListener("fullscreenchange", leaveFullscreen);

  show();
  console.info(
    `[cheatsearch] ${cpu}/${space} ${hex(base, 5)}..${hex(base + size, 5)}; ` +
      "play, then Reset at a known score and Filter with the score shown",
  );
}
