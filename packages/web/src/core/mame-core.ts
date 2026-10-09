import { CoreCapabilityError } from "./errors";
import type { CoreModule, NetplayHooks } from "./module";
import type { Core, CoreOptions, FrameInputs, StateHash } from "./types";

/**
 * Wraps one loaded stock Emscripten module. Methods that need native support
 * the stock build lacks throw CoreCapabilityError instead of guessing:
 * step/save/hash require the T20 netplay patch, readScore requires T32.
 */
export class MameCore implements Core {
  constructor(
    private readonly module: CoreModule,
    private readonly options: CoreOptions,
  ) {}

  load(): Promise<void>;
  load(state: Uint8Array): void;
  load(state?: Uint8Array): Promise<void> | void {
    if (state) {
      this.netplay("load", "T20").loadState(state);
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

  readScore(): number {
    throw new CoreCapabilityError("readScore", "T32 (scoremap)");
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
