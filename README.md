# claude-fusion

Multi-model deliberation for Claude Code. The `fusion` tool sends one prompt to a panel of models at the same time, then a judge model compares their answers and returns a structured analysis: what they agree on, where they contradict each other, what only some of them covered, what only one of them noticed, and what none of them addressed. Claude reads that analysis and writes you an answer informed by it.

Panel models can be Claude (through your Claude Code login) or anything on OpenRouter. A port of [pi-fusion](https://github.com/synthetic-recon/pi-fusion), itself inspired by OpenRouter Fusion.

## Requirements

- Claude Code 2.1.259 or later
- Node 22.18 or later (the plugin runs TypeScript directly, there is no build)
- An OpenRouter key if you want non-Claude models on the panel

## Quick start

1. Get the plugin.

   ```
   git clone https://github.com/callumw-k/claude-fusion ~/code/claude-fusion
   cd ~/code/claude-fusion && npm install
   ```

   Or as a marketplace: `claude plugin marketplace add callumw-k/claude-fusion`, then `claude plugin install claude-fusion`. A marketplace install runs `npm ci --ignore-scripts` for you, so the manual `npm install` is only for a checkout you load with `--plugin-dir`.

2. If you want OpenRouter models, export `OPENROUTER_API_KEY` in the shell that starts Claude Code.

   ```
   export OPENROUTER_API_KEY=sk-or-...    # fish: set -x OPENROUTER_API_KEY sk-or-...
   ```

3. Start Claude Code in a project.

   ```
   claude --plugin-dir ~/code/claude-fusion
   ```

   With a marketplace install, plain `claude` is enough. Under `--plugin-dir` the commands may be namespaced, so if `/fusion-init` does not resolve, type `/claude-fusion:fusion-init`.

4. Create a config.

   ```
   /fusion-init
   ```

   This writes `.claude/fusion.json` in the project with a three-model panel (Claude Opus, GPT 5.5 and Gemini 3.8 Flash through OpenRouter) judged by Opus. Edit the model list to taste. If you have no OpenRouter key, keep only `claude/*` entries, for example:

   ```json
   {
     "panel": ["claude/opus", "claude/sonnet"],
     "judge": "claude/opus"
   }
   ```

5. Check it resolved.

   ```
   /fusion-status
   ```

   You should see the panel and judge listed.

6. Ask for a deliberation.

   ```
   /fusion-report Should this service pin dependency versions exactly or use caret ranges?
   ```

   This runs the panel and judge and prints the full report. The first run takes a minute or two: every panelist is a separate model call, and the judge runs after they all finish.

## Using it

A deliberation starts in one of three ways.

### Claude decides

In the default `available` mode, Claude has the `fusion` tool and calls it when a question warrants several perspectives: research questions, architecture trade-offs, "is this the right approach", anything where being wrong is expensive. It will not use it for edits, file operations or simple questions. If you want it used more or less often, tell Claude in the conversation or in `CLAUDE.md`.

### You ask for one

`/fusion <prompt>` runs fusion on that prompt and Claude answers from the analysis. `/fusion-report <prompt>` does the same but prints the raw report instead of an answer.

### You force it for the session

`/fusion on` makes every plain prompt go through fusion first. `/fusion available` goes back to letting Claude decide. `/fusion off` blocks the tool entirely for the session (useful when you want to stop spending on it for a while). `/fusion` on its own toggles between `available` and `forced`. Modes are per session and reset when the session ends.

Forced mode works by attaching an instruction to each prompt rather than rewriting it, so Claude can still skip fusion for something trivial like "thanks". Slash commands are never forced.

### Named panels

If you keep several panels in `fusion.json`, `/fusion <name>` arms one for the next fusion call only, then the default applies again. `/fusion-status` shows which panel is armed. A panel named after a mode word (`on`, `off`, `available`, `auto`, `force`, `forced`, `disable`, `disabled`) cannot be armed this way.

```json
{
  "defaultPanel": "quick",
  "panels": {
    "quick": { "models": ["claude/sonnet", "openrouter/openai/gpt-5.4-mini"], "judge": "claude/sonnet" },
    "deep": {
      "models": ["claude/opus", "openrouter/openai/gpt-5.5", "openrouter/google/gemini-3.8-flash"],
      "judge": "claude/opus",
      "panelReasoning": "high",
      "judgeReasoning": "xhigh"
    }
  }
}
```

### Giving the panel context

Panel and judge calls do not see your conversation. When Claude calls the tool it is told to put whatever context the panel needs into the prompt, and it generally does. When you use `/fusion <prompt>` yourself, write the prompt as if to a stranger: include the constraints, the code snippet, the decision you are weighing.

### Letting Claude panelists read the repo

Set `"panelTools": "readonly"` and Claude panelists get `Read`, `Grep` and `Glob` in the project directory, bounded by `maxToolCalls` turns. So "what does this module do" is answered from the code rather than from memory. `"all"` adds `Bash`, `Edit` and `Write` (see `panelToolsConsent` below) and runs panelists one at a time.

## Reading the result

When Claude calls `fusion`, the tool returns compact JSON: the analysis plus a short excerpt from each panelist. Claude then writes the answer. Ask for the raw output if you want to see it, or use `/fusion-report` for the full text.

The analysis has five sections:

| Section | Meaning |
| --- | --- |
| Consensus | Points all or most panelists made. Treat as higher confidence. |
| Contradictions | Topics where panelists disagreed, with each stance attributed. |
| Partial coverage | Points only some panelists raised. |
| Unique insights | Something only one panelist said. |
| Blind spots | Things the judge thinks none of them addressed. |

The report from `/fusion-report` adds every panelist's full response underneath, and a `Failed models` line when any panelist errored. If only one panelist succeeded the judge is skipped and you get that answer as is.

## Configuration reference

`.claude/fusion.json` in the project wins over `~/.claude/fusion.json`. A project file can set `panelToolsConsent`, so glance at it in repos you clone before enabling `all`.

Model ids carry their backend:

- `claude/<model>`: runs `claude -p` on your Claude Code login. `opus`, `sonnet`, `haiku` and full model ids all work.
- `openrouter/<vendor>/<model>`: an OpenRouter id such as `openrouter/openai/gpt-5.5`. Text only.

What `/fusion-init` writes:

```json
{
  "defaultPanel": "default",
  "panels": {
    "default": {
      "models": ["claude/opus", "openrouter/openai/gpt-5.5", "openrouter/google/gemini-3.8-flash"],
      "judge": "claude/opus",
      "panelReasoning": "medium",
      "judgeReasoning": "high"
    }
  },
  "maxPanelModels": 3,
  "maxPanelOutputTokens": 2048,
  "maxCompletionTokens": 4096,
  "temperature": 0.3,
  "panelTools": "none",
  "maxToolCalls": 16,
  "timeoutSeconds": 600
}
```

| Key | Meaning |
| --- | --- |
| `panels`, `defaultPanel` | Named panels and which one applies by default. Top-level `panel` and `judge` are the fallback when no named panel resolves. |
| `judge` | Any model id. Omit it and the first panelist judges. |
| `panelReasoning`, `judgeReasoning` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Claude models run `minimal` as `low`. |
| `maxPanelModels` | Cap on panel size, up to 8. |
| `maxPanelOutputTokens`, `maxCompletionTokens` | OpenRouter models only. Claude models run under Claude Code's own output limit, because `claude -p` fails the whole call rather than truncating when a cap is hit. |
| `temperature` | OpenRouter models only. |
| `panelTools` | `none`, `readonly` (`Read,Grep,Glob`), `all` (adds `Bash,Edit,Write`), or an explicit list. Claude panelists only. |
| `panelToolsConsent` | Must be `true` before `Bash`, `Edit` or `Write` are given to panelists. |
| `maxToolCalls` | Passed to `claude -p --max-turns`, so it bounds model turns rather than tool calls. A panelist that hits it is reported as capped and its last message becomes its answer. |
| `timeoutSeconds` | Per model call, default 600. A panelist that exceeds it fails with `timed out`. |

## Cost and time

Each fusion call is one model call per panelist plus one judge call. Claude panelists bill to your Claude Code login. Each one is a `claude -p` process started with `--system-prompt`, `--strict-mcp-config`, `--setting-sources ""` and a restricted tool list, so it does not load your plugins, skills, MCP servers or `CLAUDE.md`. A trivial call measured about 400 input tokens against roughly 39k for an unrestricted `claude -p`. OpenRouter panelists bill to your OpenRouter account at that model's rate.

Panelists run in parallel (up to four at once, one at a time when mutating tools are on). Wall time is roughly the slowest panelist plus the judge.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `No panel configured. Run /fusion-init to create .claude/fusion.json.` | No config found, or the panel list is empty or all ids are invalid. Run `/fusion-init` or check the ids (`claude/...` or `openrouter/vendor/model`). |
| `Cannot enable forced mode: ...` | Forced mode needs a resolvable panel. Fix the config first. |
| A panelist fails with `OPENROUTER_API_KEY is not set` | Export `OPENROUTER_API_KEY` in the shell that starts Claude Code, then restart it. |
| A panelist fails with `claude CLI not found on PATH` | The `claude` binary is not visible to the plugin's server process. Usually a PATH difference between your shell and the launcher. |
| A panelist fails with `OpenRouter 402 (insufficient credits)` or `429 (rate limited)` | Top up or wait. The rest of the panel still runs and the report lists the failure. |
| A panelist fails with `timed out` | Raise `timeoutSeconds` or lower the reasoning level for that model. |
| Report says `Judge analysis unavailable` | The judge errored or returned unparseable JSON. The panel responses are still in the report. Try a different judge or lower its reasoning. |
| Tool call is denied with "Fusion is off for this session" | You ran `/fusion off`. Run `/fusion available` or `/fusion on`. |
| Forced mode seems to do nothing | Check `/fusion-status` shows `Fusion mode: forced`. |
| Warning about mutating tools and a read-only subset | `panelTools` includes `Bash`, `Edit` or `Write` without `panelToolsConsent: true`. |

Modes and armed panels live in `~/.claude/claude-fusion/sessions/` (`FUSION_DATA_DIR` overrides the directory) and are keyed by session id. Deleting that directory resets every session to `available`.

## What is not ported from pi-fusion

Auto-diverse panel selection (OpenRouter models are not "authed", so auto-picking would spend money on arbitrary models), the footer status, the setup TUI, `context_mode: recent`, and tools for OpenRouter panelists.

## Development

`npm run check`, `npm test`, `npm run check:strict`, `npm run validate`. Design notes live in `docs/superpowers/specs/`.
