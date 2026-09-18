---
description: "Fusion mode: /fusion on | available | off, /fusion <panel-name> arms a named panel once, /fusion <prompt> forces one fusion call"
argument-hint: "[on|available|off|<panel-name>|<prompt>]"
allowed-tools: Bash(node:*)
---
```!
node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" fusion <<'CLAUDE_FUSION_ARGUMENTS_END_7f3a'
$ARGUMENTS
CLAUDE_FUSION_ARGUMENTS_END_7f3a
```

Follow the instruction printed above exactly. If it contains a prompt to run, call the fusion tool with that prompt, then answer the user in your own words without pasting the raw JSON. Otherwise report the printed status to the user in one line and do nothing else.
