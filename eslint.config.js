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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { ecmaVersion: 2022, sourceType: "module" } },
);
