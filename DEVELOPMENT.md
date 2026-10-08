# Development process with opencode

## 1. How the files are organised
| File | Who reads it | Why |
| --- | --- | --- |
| `AGENTS.md` | opencode, every session | Short rules, layout, commands, pointers to docs (loaded lazily) |
| `opencode.json` | opencode | Always-loaded instructions (overview + task list) and bash permissions |
| `docs/00-08*.md` | opencode on demand, you | The design, one topic per file, so a task loads only what it needs |
| `docs/contracts/*` | both ends of every interface | Wire formats and DB schema: the code must match these exactly |
| `docs/tasks/README.md` | you + opencode | Ordered, small tasks with acceptance criteria and dependencies |
| `.opencode/agents/*` | subagents | `reviewer` and `determinism-auditor`, both read-only |
| `.opencode/commands/*` | you, as `/next-task`, `/review-task T22`, `/netplay-check` | Repeatable workflows |

## 2. The loop for every task
1. `git switch -c task/T22` and start opencode in the repo root.
2. `/next-task T22` → the Plan agent reads only the listed docs and proposes a plan. Correct it now; it is
   much cheaper than correcting code later.
3. Press Tab to switch to the Build agent, tell it to implement the approved plan, tests first.
4. Run `pnpm lint && pnpm typecheck && pnpm test` yourself (or let it, the permission is allowed).
5. `/review-task T22` → reviewer subagent checks criteria, determinism, contracts, scope.
6. Read the diff yourself, commit, tick the box in `docs/tasks/README.md`, merge.
7. Start a **new session** for the next task. Long sessions drift and fill the context.

## 3. Advice specific to this project
- **Do the determinism spike (T02) before anything else.** If one game is not deterministic under native
  record/playback, netplay and verification cannot work for it. Learn this in a day, not a month.
- **You own the C++ patch (T20).** MAME is huge and the emscripten build is slow; agents do best on small,
  well-located edits. Point opencode at exact functions (`running_machine::emscripten_main_loop` in
  `src/emu/machine.cpp`), keep the patch in `core/patches/`, and review every line.
- **Run long builds yourself.** A full `emmake` build can take a long time; run it in your terminal and paste
  the error tail into opencode instead of letting it wait on the build.
- **Contracts before code.** Change `docs/contracts/` and `packages/protocol` first, then relay and web.
  One shared TypeScript package prevents the two ends from drifting.
- **Use free ROMs for development and CI** (mamedev.org/roms). Then test fixtures and golden replays can
  be committed legally. Keep commercial ROMs in the gitignored `roms/` folder.
- **Golden replays are your best tests.** Store short input logs plus the expected final RAM hash and score;
  run them against the WASM core (Playwright) and the native verifier in CI. Any core bump must pass them.
- **Simulate bad networks on Ubuntu** with `tc qdisc add dev lo root netem delay 50ms loss 1%` while
  running two browser tabs; remove with `tc qdisc del dev lo root`.
- **Pin versions**: MAME submodule commit, emsdk version, Node version (`.nvmrc`), and record the core hash
  in every match. Mixed versions are the most common cause of desyncs.
- **Keep the agent away from secrets and ROMs**: `.env` and `roms/` are gitignored; never paste keys into chat.
- **Update the docs when reality changes.** If a task finds the design wrong, fix the relevant `docs/*.md`
  in the same PR, so later sessions do not follow outdated instructions.

## 4. Choosing models
Use your strongest model for the Plan agent, the C++ patch, the netplay loop and reviews; a faster,
cheaper model is fine for UI, CRUD endpoints, and tests that follow an existing pattern.
