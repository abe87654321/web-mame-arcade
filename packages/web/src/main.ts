import { startApp } from "./app/app";

/** Root UI entry (T13). */
export function appTitle(): string {
  return "Web MAME Arcade";
}

/** Browser bootstrap. Guarded so importing this module in tests does not start. */
export function boot(): void {
  void startApp().catch((error: unknown) => {
    console.error("failed to start app", error);
  });
}

if (typeof document !== "undefined") {
  boot();
}
