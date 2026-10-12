import { startApp } from "./app/app";
import { installScoreWatch } from "./scorewatch";

/** Root UI entry (T13). */
export function appTitle(): string {
  return "Web MAME Arcade";
}

/** Browser bootstrap. Guarded so importing this module in tests does not start. */
export function boot(): void {
  // Dev-only scoremap discovery hook (T32b); inert without ?scorewatch=1.
  if (import.meta.env.DEV && typeof window !== "undefined") {
    installScoreWatch(window);
  }
  void startApp().catch((error: unknown) => {
    console.error("failed to start app", error);
  });
}

if (typeof document !== "undefined") {
  boot();
}
