# T00 Repo Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the minimal pnpm workspace, strict TS/ESLint/Vitest tooling, CI, hygiene files and `.opencode/` workflow so `pnpm lint && pnpm typecheck && pnpm test` pass locally and in CI.

**Architecture:** Lightweight pnpm workspace, no build step. Five `@wma/*` packages extend one `tsconfig.base.json`, type-check with `tsc --noEmit`, test with Vitest. Root scripts fan out with `pnpm -r`. One root ESLint flat config.

**Tech Stack:** Node 24 (`.nvmrc`), pnpm 11.5.2, TypeScript (strict), ESLint 9 flat + typescript-eslint, Vitest, Vite (web only), GitHub Actions.

---

## Task 1: Root workspace files

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.nvmrc`
- Create: `.gitignore`

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create `.nvmrc`**

```
24
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
roms/
*.wasm
core/out/
.env
.env.*
dist/
coverage/
*.log
.DS_Store
```

- [ ] **Step 4: Create root `package.json`**

```json
{
  "name": "web-mame-arcade",
  "private": true,
  "packageManager": "pnpm@11.5.2",
  "engines": { "node": ">=24" },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/node": "^24.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.0.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 5: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json .nvmrc .gitignore
git commit -m "chore(T00): add workspace, tsconfig, nvmrc and gitignore"
```

## Task 2: ESLint flat config

**Files:**
- Create: `eslint.config.js`

- [ ] **Step 1: Create `eslint.config.js`**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { ecmaVersion: 2022, sourceType: "module" } },
);
```

- [ ] **Step 2: Commit**

```bash
git add eslint.config.js
git commit -m "chore(T00): add eslint flat config"
```

## Task 3: `@wma/protocol` package

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/index.test.ts`

- [ ] **Step 1: Create `packages/protocol/package.json`**

```json
{
  "name": "@wma/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `packages/protocol/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": [] },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test** — `packages/protocol/src/index.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index";

describe("PROTOCOL_VERSION", () => {
  it("is 1 per the input-packet contract", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @wma/protocol test`
Expected: FAIL — cannot resolve `./index` (no source yet).

- [ ] **Step 5: Create `packages/protocol/src/index.ts`**

```ts
/** Protocol version, matching docs/contracts/input-packet.md. */
export const PROTOCOL_VERSION = 1;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @wma/protocol test`
Expected: PASS — 1 test.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol
git commit -m "feat(T00): scaffold @wma/protocol with version smoke test"
```

## Task 4: `@wma/relay` package

**Files:**
- Create: `packages/relay/package.json`, `packages/relay/tsconfig.json`, `packages/relay/src/index.ts`, `packages/relay/src/index.test.ts`

- [ ] **Step 1: Create `packages/relay/package.json`**

```json
{
  "name": "@wma/relay",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `packages/relay/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test** — `packages/relay/src/index.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { serviceName } from "./index";

describe("relay serviceName", () => {
  it("identifies the package", () => {
    expect(serviceName).toBe("@wma/relay");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @wma/relay test`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 5: Create `packages/relay/src/index.ts`**

```ts
/** Room relay service (implemented in T22). */
export const serviceName = "@wma/relay";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @wma/relay test`
Expected: PASS — 1 test.

- [ ] **Step 7: Commit**

```bash
git add packages/relay
git commit -m "feat(T00): scaffold @wma/relay with smoke test"
```

## Task 5: `@wma/api` package

**Files:**
- Create: `packages/api/package.json`, `packages/api/tsconfig.json`, `packages/api/src/index.ts`, `packages/api/src/index.test.ts`

- [ ] **Step 1: Create `packages/api/package.json`**

```json
{
  "name": "@wma/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `packages/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test** — `packages/api/src/index.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { serviceName } from "./index";

describe("api serviceName", () => {
  it("identifies the package", () => {
    expect(serviceName).toBe("@wma/api");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @wma/api test`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 5: Create `packages/api/src/index.ts`**

```ts
/** REST API service (implemented in T34). */
export const serviceName = "@wma/api";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @wma/api test`
Expected: PASS — 1 test.

- [ ] **Step 7: Commit**

```bash
git add packages/api
git commit -m "feat(T00): scaffold @wma/api with smoke test"
```

## Task 6: `@wma/verifier` package

**Files:**
- Create: `packages/verifier/package.json`, `packages/verifier/tsconfig.json`, `packages/verifier/src/index.ts`, `packages/verifier/src/index.test.ts`

- [ ] **Step 1: Create `packages/verifier/package.json`**

```json
{
  "name": "@wma/verifier",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `packages/verifier/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 3: Write the failing test** — `packages/verifier/src/index.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { serviceName } from "./index";

describe("verifier serviceName", () => {
  it("identifies the package", () => {
    expect(serviceName).toBe("@wma/verifier");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @wma/verifier test`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 5: Create `packages/verifier/src/index.ts`**

```ts
/** Score verifier worker (implemented in T33). */
export const serviceName = "@wma/verifier";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @wma/verifier test`
Expected: PASS — 1 test.

- [ ] **Step 7: Commit**

```bash
git add packages/verifier
git commit -m "feat(T00): scaffold @wma/verifier with smoke test"
```

## Task 7: `@wma/web` package (Vite)

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/main.ts`, `packages/web/src/main.test.ts`

- [ ] **Step 1: Create `packages/web/package.json`**

```json
{
  "name": "@wma/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `packages/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 3: Write the failing test** — `packages/web/src/main.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { appTitle } from "./main";

describe("appTitle", () => {
  it("returns the app name", () => {
    expect(appTitle()).toBe("Web MAME Arcade");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @wma/web test`
Expected: FAIL — cannot resolve `./main`.

- [ ] **Step 5: Create `packages/web/vite.config.ts`**

```ts
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
```

- [ ] **Step 6: Create `packages/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Web MAME Arcade</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 7: Create `packages/web/src/main.ts`**

```ts
/** Root UI entry (grows in T13). */
export function appTitle(): string {
  return "Web MAME Arcade";
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @wma/web test`
Expected: PASS — 1 test.

- [ ] **Step 9: Commit**

```bash
git add packages/web
git commit -m "feat(T00): scaffold @wma/web (vite) with smoke test"
```

## Task 8: Install, verify and commit lockfile

**Files:**
- Modify: `package.json` (add the `pnpm.onlyBuiltDependencies` allow-list)
- Create: `pnpm-lock.yaml` (generated)

- [ ] **Step 1: Allow esbuild's build script (pnpm 11 gate)**

pnpm 11 refuses to run when a dependency has an unapproved build script, failing with
`ERR_PNPM_IGNORED_BUILDS: esbuild@...`. Add this top-level block to the root `package.json` (keep all
existing fields):

```json
"pnpm": { "onlyBuiltDependencies": ["esbuild"] }
```

- [ ] **Step 2: Install dependencies**

Run: `pnpm install`
Expected: lockfile written, `node_modules` populated, no `ERR_PNPM_IGNORED_BUILDS`. If a listed dependency
range does not resolve, run `pnpm add -D -w <pkg>@latest` for that package and re-run.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: `tsc --noEmit` succeeds in all five packages, no errors.

- [ ] **Step 5: Test**

Run: `pnpm test`
Expected: 5 packages, 5 passing tests, exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(T00): add pnpm lockfile and esbuild build allow-list"
```

## Task 9: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 11.5.2
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(T00): add lint + typecheck + test workflow"
```

## Task 10: `.opencode/` agents

**Files:**
- Create: `.opencode/agents/reviewer.md`
- Create: `.opencode/agents/determinism-auditor.md`

- [ ] **Step 1: Create `.opencode/agents/reviewer.md`**

```markdown
---
description: Reviews the current diff against a task's acceptance criteria, contracts and scope. Read-only.
mode: subagent
permission:
  edit: deny
---

You are the task reviewer for the Web MAME Arcade repo. You are read-only: never edit files and never run
state-changing commands.

When invoked with a task id (e.g. T00):
- Read the task entry in `docs/tasks/README.md` and any `docs/tasks/<id>-*.md`.
- Read the contracts the task touches under `docs/contracts/`.
- Inspect the current diff (`git diff main...HEAD`).
- Check exactly against the task's acceptance criteria, the contracts, and the stated scope. Flag scope
  creep and any criterion not met.
- Report: PASS/FAIL per criterion, then blockers, then nits. Cite `file:line`.
```

- [ ] **Step 2: Create `.opencode/agents/determinism-auditor.md`**

```markdown
---
description: Audits changes on the emulation path for nondeterminism. Read-only.
mode: subagent
permission:
  edit: deny
---

You audit the Web MAME Arcade emulation path for anything that would make peers or the verifier diverge.
Read-only.

Look for: wall-clock time (`Date.now`, `performance.now` in the emulation path), `Math.random`,
locale-dependent formatting, unordered iteration over `Map`/objects that affects inputs, floating-point in
frame stepping, and any build input (core hash, ROM hash, DIP/options) that is not identical across peers
and the verifier.

Report each finding as `file:line`, why it breaks determinism, and a concrete fix.
```

- [ ] **Step 3: Commit**

```bash
git add .opencode/agents
git commit -m "chore(T00): add reviewer and determinism-auditor agents"
```

## Task 11: `.opencode/` commands

**Files:**
- Create: `.opencode/commands/next-task.md`
- Create: `.opencode/commands/review-task.md`
- Create: `.opencode/commands/netplay-check.md`

- [ ] **Step 1: Create `.opencode/commands/next-task.md`**

```markdown
---
description: Plan a task from docs/tasks by id without writing code.
agent: plan
---

Read `docs/tasks/README.md` and find the line for task `$ARGUMENTS`. Read only the docs that task lists,
plus its `docs/tasks/$ARGUMENTS-*.md` files if present. Produce a step-by-step implementation plan: exact
files to touch, tests first, commands with expected output, and a commit per logical change. Do not write
or modify any code in this command.
```

- [ ] **Step 2: Create `.opencode/commands/review-task.md`**

```markdown
---
description: Review a task's diff against its acceptance criteria. Read-only.
agent: plan
---

Review task `$1` in the current branch:
- Dispatch the `reviewer` subagent to check acceptance criteria, contracts and scope on `git diff main...HEAD`.
- Dispatch the `determinism-auditor` subagent if the diff touches the emulation path (`core/`, WASM step/hash code, `packages/*/core`).
Summarize: PASS/FAIL per criterion, blockers, nits, with `file:line` citations.
```

- [ ] **Step 3: Create `.opencode/commands/netplay-check.md`**

```markdown
---
description: Stub for netplay determinism checks (golden replay / two-tab). Not ready until T24–T26.
agent: plan
---

Netplay determinism checks are not available yet — they require the netplay patch (T20), lockstep loop
(T24), desync detection (T25) and the two-tab harness (T26). Until then, the closest check is the native
record/playback determinism spike (T02): record a session, replay twice, compare the RAM hash.

When the prerequisites exist, this command will:
1. Run the golden-replay suite: replay stored input logs against the WASM core and the native verifier,
   asserting equal final RAM hash and score.
2. Run two browser tabs under `tc netem` profiles (50/100/150 ms, 1% loss) and assert equal per-60-frame hashes.
Report PASS/FAIL and attach the failing frame and hash.
```

- [ ] **Step 4: Commit**

```bash
git add .opencode/commands
git commit -m "chore(T00): add next-task, review-task and netplay-check commands"
```

## Task 12: Push and verify CI

- [ ] **Step 1: Push the branch**

Run: `git push -u origin task/T00`
Expected: branch pushed.

- [ ] **Step 2: Verify CI is green**

Open the Actions run for `task/T00` (or run `gh run list`, if `gh` is installed) and confirm the `ci` job
passes. Expected: green.

- [ ] **Step 3: Mark T00 done**

Edit `docs/tasks/README.md`: change `- [ ] **T00` to `- [x] **T00`.

```bash
git add docs/tasks/README.md
git commit -m "docs(tasks): mark T00 done"
git push
```

## Task 13: Restart opencode (manual)

opencode does not hot-reload config.

- [ ] **Step 1:** Quit and restart opencode in the repo root.
- [ ] **Step 2:** Confirm `/next-task`, `/review-task`, `/netplay-check` appear, and the `reviewer` and
  `determinism-auditor` subagents are available.

## Self-review notes

- **Spec coverage:** workspace+pkg names (Q1/Q3) → Tasks 1,3–7; CI single job (Q2) → Task 9; root-only
  dev deps → Task 1; `.opencode/` agents+commands → Tasks 10–11; `.gitignore`/`.nvmrc` → Task 1; Node 24
  decision → Task 1 + docs already updated.
- **No placeholders:** every file has full content and every command has expected output.
- **Type consistency:** `PROTOCOL_VERSION`, `serviceName`, `appTitle` are each defined once and referenced
  by exactly one test.
