---
description: "Write an example .claude/fusion.json into the current project"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" init`

Report the result printed above to the user. If a file was written, remind them to edit the panel to taste. Only mention OPENROUTER_API_KEY if the output above says it is not set.
