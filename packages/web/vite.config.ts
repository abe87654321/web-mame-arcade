import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Dev arcade is meant to be opened from other machines on the LAN.
    host: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
