import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "mame/**",
      "core/out/**",
      // Injected into the MAME build (not app source); uses Emscripten globals.
      "core/patches/**",
      "roms/**",
      // Dev-time copies of the built cores (huge Emscripten glue, not ours).
      "**/public/static/**",
      "**/public/roms/**",
      // Design-harness scratch output (git-ignored).
      "gan-harness/**",
      // Playwright report/trace artifacts (git-ignored, generated locally).
      "e2e/playwright-report/**",
      "e2e/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { ecmaVersion: 2022, sourceType: "module" } },
  {
    // Node tooling under core/ (build/spike scripts and their node:test suites)
    // runs on Node, so the Node globals are available there.
    files: ["core/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", Buffer: "readonly" },
    },
  },
);
