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

  const manifestJson = await (
    await doFetch(`${init.coreBaseUrl}/manifest.json`)
  ).json();
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
      _manifest: unknown,
      args: readonly string[],
    ): Promise<CoreModule> => {
      let settleReady!: (module: CoreModule) => void;
      let abortReady!: (reason: Error) => void;
      const ready = new Promise<CoreModule>((resolve, reject) => {
        settleReady = resolve;
        abortReady = reject;
      });
      const config: Record<string, unknown> = {
        arguments: [...args],
        preRun: [
          () =>
            mountRom(
              config as unknown as CoreModule,
              init.romPath,
              init.romZipName,
              romZip,
            ),
        ],
        onRuntimeInitialized: () =>
          settleReady(config as unknown as CoreModule),
        onAbort: (what: unknown) =>
          abortReady(new Error(`core runtime aborted: ${String(what)}`)),
      };
      (globalThis as Record<string, unknown>).Module = config;
      await loadScript(`${init.coreBaseUrl}/mame${init.driver}.js`);
      return ready;
    },
  };

  const bundle = await loadCoreBundle(source, init.args);
  return new MameCore(bundle.module, {
    args: init.args,
    romPath: init.romPath,
    romZipName: init.romZipName,
  });
}
