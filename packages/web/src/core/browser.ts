import { loadCoreBundle } from "./loader";
import { MameCore } from "./mame-core";
import { mountRom } from "./rom";
import type { CoreModule } from "./module";
import type { Core } from "./types";

export interface BrowserCoreInit {
  /** Directory URL holding manifest.json and mame<driver>.{js,wasm}. */
  coreBaseUrl: string;
  /** URL of the ROM zip for the driver. */
  romZipUrl: string;
  driver: string;
  /** Fixed args from buildMameArgs(). */
  args: readonly string[];
  romPath: string;
  romZipName: string;
  /**
   * Arm the netplay frame gate at load so the machine freezes at boot and the
   * lockstep drives every frame (T24, docs/03). Solo leaves this unset.
   */
  netplay?: boolean;
}

export interface BrowserCoreDeps {
  fetchImpl?: typeof fetch;
  /** Loads the generated classic <script> and resolves once it has run. */
  loadScript?: (url: string) => Promise<void>;
}

/** Default loader: seed global Module, append <script src>, await load. */
function injectScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load core script ${url}`));
    document.head.appendChild(el);
  });
}

/**
 * Fetch, verify and boot a stock core bundle in a browser tab. The stock
 * Emscripten build is not MODULARIZE'd: it reads a pre-seeded global `Module`,
 * runs preRun (where we mount the ROM) and auto-starts main.
 */
export async function loadBrowserCore(
  init: BrowserCoreInit,
  deps: BrowserCoreDeps = {},
): Promise<Core> {
  const doFetch = deps.fetchImpl ?? fetch;
  const loadScript = deps.loadScript ?? injectScript;
  const trace = (stage: string): void => {
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      console.info(`[core] ${stage}`);
    }
  };

  trace("fetching manifest");
  const manifestJson = await (
    await doFetch(`${init.coreBaseUrl}/manifest.json`)
  ).json();
  trace("fetching rom");
  const romZip = new Uint8Array(
    await (await doFetch(init.romZipUrl)).arrayBuffer(),
  );

  const source = {
    manifestJson,
    fetchArtifact: async (name: string): Promise<Uint8Array> =>
      new Uint8Array(
        await (await doFetch(`${init.coreBaseUrl}/${name}`)).arrayBuffer(),
      ),
    createModule: async (
      manifest: unknown,
      args: readonly string[],
    ): Promise<CoreModule> => {
      // The build names the glue after MAME's project (`mame<driver>.js`) but
      // emits `<driver>.js` when that target is not used; always trust the
      // manifest's artifact list rather than guessing.
      const artifacts =
        (manifest as { artifacts?: Record<string, string> }).artifacts ?? {};
      const jsName =
        Object.keys(artifacts).find((name) => name.endsWith(".js")) ??
        `mame${init.driver}.js`;
      let timer: ReturnType<typeof setTimeout>;
      let settle!: (module: CoreModule) => void;
      let abort!: (reason: Error) => void;
      const ready = new Promise<CoreModule>((resolve, reject) => {
        settle = (module) => {
          clearTimeout(timer);
          resolve(module);
        };
        abort = (reason) => {
          clearTimeout(timer);
          reject(reason);
        };
        timer = setTimeout(
          () => abort(new Error("core did not finish booting within 90s")),
          90_000,
        );
      });
      const config: Record<string, unknown> = {
        arguments: [...args],
        // Mount at runtime init, not preRun: the ROM needs `Module.FS`, which is
        // only present once the runtime is up. This still runs before MAME's
        // callMain() starts the machine.
        onRuntimeInitialized: () => {
          try {
            mountRom(
              config as unknown as CoreModule,
              init.romPath,
              init.romZipName,
              romZip,
            );
          } catch (error) {
            abort(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          settle(config as unknown as CoreModule);
        },
        onAbort: (what: unknown) =>
          abort(new Error(`core runtime aborted: ${String(what)}`)),
      };
      (globalThis as Record<string, unknown>).Module = config;
      trace(`loading script ${jsName}`);
      await loadScript(`${init.coreBaseUrl}/${jsName}`);
      trace("script loaded, awaiting runtime");
      return ready;
    },
  };

  trace("verifying artifacts + booting");
  const bundle = await loadCoreBundle(source, init.args);
  trace("runtime ready");
  // Arm netplay now: the post-js glue has run (so `module.netplay` exists) but
  // the main loop has not ticked yet, so the machine freezes at boot instead of
  // free-running ahead of the lockstep (T24, docs/03).
  if (init.netplay) bundle.module.netplay?.enable();
  return new MameCore(bundle.module, {
    args: init.args,
    romPath: init.romPath,
    romZipName: init.romZipName,
  });
}
