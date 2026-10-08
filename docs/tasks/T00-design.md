# T00 · Repo scaffold — Design

> Status: approved. See `docs/tasks/README.md` (T00) for the task entry.

## Goal

Create the minimal, working foundation the rest of the project builds on: a pnpm workspace with the
five packages (`@wma/protocol`, `@wma/web`, `@wma/relay`, `@wma/api`, `@wma/verifier`), strict TypeScript,
ESLint, Vitest, a CI workflow, repo hygiene files, and the `.opencode/` agents and commands that
`DEVELOPMENT.md`'s per-task loop depends on.

`pnpm lint && pnpm typecheck && pnpm test` must pass locally and in CI. No business logic beyond
placeholders with one smoke test each.

## Approach

Lightweight pnpm workspace, **no TypeScript project references / no build step**. Each package extends a
shared `tsconfig.base.json`, type-checks with `tsc --noEmit`, and tests with Vitest. A single root ESLint
flat config. The root fans out with `pnpm -r`. This is the smallest thing that satisfies T00; project
references or an orchestrator (Nx/Turbo) are deferred (YAGNI) until packages actually depend on each other.

## Tech stack

- Node.js 24 (pinned via `.nvmrc`), pnpm 11.5.2 (pinned via `packageManager`), corepack.
- TypeScript (strict), ESLint 9 flat config + typescript-eslint, Vitest.
- Vite for `@wma/web` only (no build run in CI at T00).
- CI: GitHub Actions, single `ubuntu-latest` job.

## File structure

```
pnpm-workspace.yaml
package.json
tsconfig.base.json
eslint.config.js
.nvmrc
.gitignore
.github/workflows/ci.yml
opencode.json                         # unchanged except where noted
.opencode/agents/reviewer.md
.opencode/agents/determinism-auditor.md
.opencode/commands/next-task.md
.opencode/commands/review-task.md
.opencode/commands/netplay-check.md
packages/protocol/{package.json, tsconfig.json, src/index.ts, src/index.test.ts}
packages/web/{package.json, tsconfig.json, vite.config.ts, index.html, src/main.ts, src/main.test.ts}
packages/relay/{package.json, tsconfig.json, src/index.ts, src/index.test.ts}
packages/api/{package.json, tsconfig.json, src/index.ts, src/index.test.ts}
packages/verifier/{package.json, tsconfig.json, src/index.ts, src/index.test.ts}
```

Not created here: `core/`, `mame/`, `deploy/`, `docs/contracts/input-log.md` (T01, T10, T42, T30).

## Root configuration

- `pnpm-workspace.yaml`: `packages: ["packages/*"]`.
- `package.json`: `private: true`, `"packageManager": "pnpm@11.5.2"`, `engines.node: ">=24"`,
  scripts `lint` (`eslint .`), `typecheck` (`pnpm -r typecheck`), `test` (`pnpm -r test`).
- `tsconfig.base.json`: `target ES2022`, `module ESNext`, `moduleResolution Bundler`, `strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`,
  `skipLibCheck`, `noEmit`. Each package `tsconfig.json` extends it and sets `include`.
- Shared dev dependencies live at the root only (`typescript`, `vitest`, `vite`, `eslint`,
  `typescript-eslint`, `@types/node`); with pnpm, the workspace root `node_modules/.bin` is on the PATH for
  package scripts, and TS/Node resolution walks up to the root `node_modules`.
- Root `test` fans out with `pnpm -r test` (one Vitest process per package); no `vitest.workspace.ts` is
  needed at T00 (would be dead config — the root script does not read it).

## Packages (placeholder + smoke test)

All packages are `@wma/<name>`, `version 0.0.0`, `private: true`, `type: module`, with scripts
`test: vitest run` and `typecheck: tsc --noEmit`.

- `@wma/protocol`: exports `PROTOCOL_VERSION = 1` (matching `docs/contracts/input-packet.md`); test asserts it is `1`.
- `@wma/relay`, `@wma/api`, `@wma/verifier`: each exports a trivial placeholder constant/function; one test asserts it.
- `@wma/web`: `src/main.ts` exports a trivial function with a test; `index.html` + `vite.config.ts` make
  `vite build` runnable (not executed in CI at T00). Uses the root `vite`/`vitest` dev deps (no per-package dev deps).

## CI (`.github/workflows/ci.yml`)

Triggered on push and pull_request. Single job on `ubuntu-latest`:
checkout → `pnpm/action-setup@v4` with `version: 11.5.2` → `actions/setup-node` with
`node-version-file: .nvmrc` and `cache: pnpm` → `pnpm install --frozen-lockfile` → `pnpm lint` →
`pnpm typecheck` → `pnpm test`.

(pnpm is set up *before* `setup-node` so its `cache: pnpm` step can resolve the store path.)

`pnpm-lock.yaml` is committed.

## `.opencode/` definitions

opencode loads project agents from `.opencode/agent(s)/<name>.md` and commands from
`.opencode/command(s)/<name>.md`.

- Agents (`mode: subagent`, read-only with `permission: { edit: deny }`):
  - `reviewer` — reviews the current diff against a task's acceptance criteria, contracts and scope.
  - `determinism-auditor` — reviews changes on the emulation path for nondeterminism (wall-clock time,
    randomness, locale-dependent code, differing build inputs).
- Commands (frontmatter + body template, `$ARGUMENTS` / `$1` substitution):
  - `next-task <id>` (`agent: plan`) — looks up the task line in `docs/tasks/README.md`, reads only the docs
    it lists, and produces an implementation plan. Writes no code.
  - `review-task <id>` — dispatches the `reviewer` and `determinism-auditor` subagents and checks the task's
    acceptance criteria.
  - `netplay-check` — documents the golden-replay / two-tab determinism checks; it is a stub that states its
    prerequisites (T24–T26) are not ready until then.

## Repo hygiene

- `.gitignore`: `node_modules/`, `roms/`, `*.wasm`, `core/out/`, `.env`, `.env.*`, `dist/`, `coverage/`,
  `*.log`, `.DS_Store`.
- `.nvmrc`: `24` (matches the dev machine and the pinned Node in `docs/06`).

## Acceptance criteria

- [ ] `pnpm install` completes and `pnpm-lock.yaml` is committed.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally.
- [ ] CI workflow is green on push.
- [ ] `.opencode/` agents and commands exist; after restarting opencode, `/next-task`, `/review-task`,
      `/netplay-check` and both subagents are available.

## Out of scope

- Any real protocol message encoding (T21), core wrapper (T11), netplay patch (T20), or services logic.
- Turborepo/Nx, TypeScript project references, publishing, formatting tooling.

## Decisions

- **Node pinned to 24.** `docs/06` previously said Node 22; the pin and the docs are bumped to Node 24 to
  match the actual dev/target environment.

## Risks / notes

- **opencode config is not hot-reloaded.** After T00, opencode must be quit and restarted for the new
  commands/agents to load.
- `pnpm-lock.yaml` must be generated with the pinned pnpm major; `--frozen-lockfile` in CI fails otherwise.
- `packageManager` must match the actual pnpm version to avoid corepack conflicts.
