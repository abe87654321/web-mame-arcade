import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * Dev-only sinks for the scorewatch hook (T32b scoremap discovery). The browser
 * POSTs program-RAM samples and screen captures here; they land in
 * /tmp/gridlee_ram.log and /tmp/snaps/<frame>.png on the dev host so the score
 * cell can be found without a (slow) remote display. `apply: "serve"` keeps this
 * out of production builds.
 */
function scorewatchSink(): Plugin {
  const log = "/tmp/gridlee_ram.log";
  const shots = "/tmp/snaps";
  return {
    name: "wma-scorewatch",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__scorewatch", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            appendFileSync(log, body.endsWith("\n") ? body : `${body}\n`);
          } catch {
            // A failed write must not break the dev server.
          }
          res.statusCode = 204;
          res.end();
        });
      });
      server.middlewares.use("/__shot", (req, res) => {
        const frame = (req.url ?? "").replace(/^\/+/, "").split("?")[0] || "x";
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const base64 = body.includes(",") ? body.slice(body.indexOf(",") + 1) : body;
            mkdirSync(shots, { recursive: true });
            writeFileSync(`${shots}/${frame}.png`, Buffer.from(base64, "base64"));
          } catch {
            // Ignore a malformed capture.
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

/**
 * Dev-only: serve `/roms/<driver>.zip` from the repo-root `roms/` directory so
 * the gitignored, locally supplied ROMs (commercial titles, docs/07) are usable
 * without ever copying them into `public/`. Falls through to the Vite static
 * handler for any name we do not have. `apply: "serve"` keeps this out of
 * production builds.
 */
function devRoms(): Plugin {
  const romsDir = fileURLToPath(new URL("../../roms", import.meta.url));
  return {
    name: "wma-dev-roms",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/roms", (req, res, next) => {
        const raw = (req.url ?? "").split("?")[0] ?? "";
        let name: string;
        try {
          name = decodeURIComponent(raw.replace(/^\/+/, ""));
        } catch {
          next();
          return;
        }
        if (!name || name.includes("/") || !name.endsWith(".zip")) {
          next();
          return;
        }
        const file = resolve(romsDir, name);
        if (!file.startsWith(romsDir + sep) || !existsSync(file)) {
          next();
          return;
        }
        res.setHeader("content-type", "application/zip");
        const stream = createReadStream(file);
        stream.on("error", () => {
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        });
        stream.pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [scorewatchSink(), devRoms()],
  server: {
    // Dev arcade is meant to be opened from other machines on the LAN.
    host: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
