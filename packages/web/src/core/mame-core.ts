import { CoreCapabilityError } from "./errors";
import type { CoreModule, NetplayHooks } from "./module";
import { decodeScore } from "./scoremap";
import type { Core, CoreOptions, FrameInputs, StateHash } from "./types";

/**
 * Wraps one loaded stock Emscripten module. Methods that need native support
 * the stock build lacks throw CoreCapabilityError instead of guessing:
 * step/save/hash require the T20 netplay patch, readScore requires T32b.
 */
export class MameCore implements Core {
  constructor(
    private readonly module: CoreModule,
    private readonly options: CoreOptions,
  ) {}

  load(): Promise<void>;
  load(state: Uint8Array, frame: number): void;
  load(state?: Uint8Array, frame?: number): Promise<void> | void {
    if (state) {
      const np = this.netplay("load", "T20");
      np.loadState(state);
      if (frame !== undefined) {
        // Resync the native frame clock; a core built before T25 lacks it.
        if (typeof np.setFrame !== "function") {
          throw new CoreCapabilityError("load", "T25 (core rebuild)");
        }
        np.setFrame(frame);
      }
      return;
    }
    // The ROM is mounted in the module's preRun hook and MAME auto-starts, so
    // by the time we hold the module it is already running.
    return Promise.resolve();
  }

  step(frame: number, inputs: FrameInputs): void {
    const np = this.netplay("step", "T20");
    np.setInputs(frame, inputs[0], inputs[1], inputs[2], inputs[3]);
    np.step(frame);
  }

  save(): Uint8Array {
    return this.netplay("save", "T20").saveState();
  }

  hash(): StateHash {
    return this.netplay("hash", "T20").hash();
  }

  /**
   * T46 diagnostic: a one-line dump of the scheduler clock and frame gate. Only
   * the T46-instrumented core provides `info`; an older core returns "".
   */
  debugInfo(): string {
    const hooks = this.module.netplay as (NetplayHooks & { info?: () => string }) | undefined;
    return hooks?.info ? hooks.info() : "";
  }

  readScore(slot: number): number {
    // Which memory to read comes from the driver's scoremap (T32b); a driver
    // without one, or a core built before the read hook, cannot report.
    const entry = this.options.score?.players.find((player) => player.slot === slot);
    if (!entry) {
      throw new CoreCapabilityError("readScore", `T32b (no scoremap, slot ${slot})`);
    }
    const np = this.netplay("readScore", "T32b");
    if (typeof np.readMemory !== "function") {
      throw new CoreCapabilityError("readScore", "T32b (core rebuild)");
    }
    const bytes = np.readMemory(entry.cpu, entry.space, Number(entry.addr), entry.len);
    return decodeScore(bytes, entry);
  }

  reset(): void {
    this.module.JSMAME.soft_reset();
  }

  destroy(): void {
    this.module.JSMAME.exit();
  }

  private netplay(method: string, task: string): NetplayHooks {
    const hooks = this.module.netplay;
    if (!hooks) {
      throw new CoreCapabilityError(method, task);
    }
    return hooks;
  }
}
