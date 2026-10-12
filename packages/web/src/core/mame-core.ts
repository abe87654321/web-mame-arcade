import { CoreCapabilityError } from "./errors";
import type { CoreModule, NetplayHooks } from "./module";
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

  readScore(slot: number): number {
    // The native memory read (`netplay_read_bytes`) and the scoremap decode
    // land in T32b; a stock core or a driver with no scoremap cannot report.
    throw new CoreCapabilityError("readScore", `T32b (scoremap, slot ${slot})`);
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
