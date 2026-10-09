/** Thrown when a Core method needs native support absent from this build. */
export class CoreCapabilityError extends Error {
  constructor(method: string, task: string) {
    super(
      `Core.${method}() requires native support from ${task}, ` +
        `which the stock WASM core does not provide`,
    );
    this.name = "CoreCapabilityError";
  }
}
