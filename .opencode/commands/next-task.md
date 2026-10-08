---
description: Plan a task from docs/tasks by id without writing code.
agent: plan
---

Read `docs/tasks/README.md` and find the line for task `$ARGUMENTS`. Read only the docs that task lists,
plus its `docs/tasks/$ARGUMENTS-*.md` files if present. Produce a step-by-step implementation plan: exact
files to touch, tests first, commands with expected output, and a commit per logical change. Do not write
or modify any code in this command.
