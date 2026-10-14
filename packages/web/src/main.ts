import { startApp } from "./app/app";
import { installCheatSearch } from "./cheatsearch";
import { installScoreWatch } from "./scorewatch";

/** Root UI entry (T13). */
export function appTitle(): string {
  return "Web MAME Arcade";
}

/** Browser bootstrap. Guarded so importing this module in tests does not start. */
export function boot(): void {
  // Dev-only scoremap discovery hooks; inert without their query param.
  if (import.meta.env.DEV && typeof window !== "undefined") {
    installScoreWatch(window);
    installCheatSearch(window);
  }
  void startApp().catch((error: unknown) => {
    console.error("failed to start app", error);
  });
}

if (typeof document !== "undefined") {
  boot();
}
