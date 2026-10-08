---
description: Review a task's diff against its acceptance criteria. Read-only.
agent: plan
---

Review task `$1` in the current branch:
- Dispatch the `reviewer` subagent to check acceptance criteria, contracts and scope on `git diff main...HEAD`.
- Dispatch the `determinism-auditor` subagent if the diff touches the emulation path (`core/`, WASM step/hash code, `packages/*/core`).
Summarize: PASS/FAIL per criterion, blockers, nits, with `file:line` citations.
