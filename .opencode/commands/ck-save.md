---
description: Save a ck session-state snapshot.
---

Load the `ck` skill and follow its `/ck:save` flow: analyze the current session and draft
`{summary, leftOff, nextSteps, decisions, blockers}`, show the draft to the user, wait for confirmation,
then run:

    echo '<json>' | node "$HOME/.config/opencode/skills/ck/commands/save.mjs"

Display the script's output verbatim.
