# claude-fusion

Multi-model deliberation for Claude Code. The `fusion` tool sends one prompt to a panel of models at the same time, then a judge model compares their answers and returns a structured analysis: what they agree on, where they contradict each other, what only some of them covered, what only one of them noticed, and what none of them addressed. Claude reads that analysis and writes you an answer informed by it.

Panel models can be Claude (through your Claude Code login), OpenAI models through the Codex CLI (on your ChatGPT login), Gemini and other models through the Antigravity CLI (on your Google login), or anything on OpenRouter. A port of [pi-fusion](https://github.com/synthetic-recon/pi-fusion), itself inspired by OpenRouter Fusion.

## Requirements

- Claude Code 2.1.259 or later
- Node 22.18 or later (the plugin runs TypeScript directly, there is no build)
- For non-Claude models on the panel, any of: an OpenRouter key, the [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`) logged in to a ChatGPT account with Codex access, or the [Antigravity CLI](https://antigravity.google/docs/cli/install) (`curl -fsSL https://antigravity.google/cli/install.sh | bash`) logged in to a Google account

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

   If you want OpenAI models on a ChatGPT subscription instead, run `codex login` once and check `codex login status` says you are logged in with ChatGPT. For Gemini on a Google account, run `agy` once and finish the browser sign-in it opens, then check `agy models` lists models rather than a login error.

3. Start Claude Code in a project.

   ```
   claude --plugin-dir ~/code/claude-fusion
   ```

   With a marketplace install, plain `claude` is enough. Under `--plugin-dir` the commands may be namespaced, so if `/fusion-init` does not resolve, type `/claude-fusion:fusion-init`.

4. Create a config.

   ```
   /fusion-init
   ```

   This writes `.claude/fusion.json` in the project with a three-model panel (Claude Opus, an OpenAI model and a Gemini model) judged by Opus. The OpenAI seat is `codex/gpt-5.6-terra` when the Codex CLI is on `PATH` and `openrouter/openai/gpt-5.5` otherwise. The Gemini seat is `agy/gemini-3.8-flash` when the Antigravity CLI is on `PATH` and `openrouter/google/gemini-3.8-flash` otherwise. The output names any CLI it could not find. Edit the model list to taste. Without an OpenRouter key or either CLI, keep only `claude/*` entries. With both CLIs logged in the file looks like:

   ```json
   {
     "panel": ["claude/opus", "codex/gpt-5.6-terra", "agy/gemini-3.8-flash"],
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

Model ids carry their backend. What each backend accepts, and which config keys reach it:

| | `claude/…` | `codex/…` | `agy/…` | `openrouter/…` |
| --- | --- | --- | --- | --- |
| Id format | `claude/<alias or model id>` | `codex/<model slug>` | `agy/<model id>` | `openrouter/<vendor>/<model>` |
| Examples | `claude/opus`, `claude/sonnet`, `claude/haiku`, `claude/claude-opus-5` | `codex/gpt-5.5`, `codex/gpt-5.6-terra` | `agy/gemini-3.8-flash`, `agy/gemini-3.1-pro-high`, `agy/claude-sonnet-4-6` | `openrouter/openai/gpt-5.5`, `openrouter/google/gemini-3.8-flash` |
| Runs as | `claude -p` on your Claude Code login | `codex exec` on your ChatGPT login | `agy -p` on your Google login | HTTPS call billed to your OpenRouter account |
| Needs | `claude` on `PATH` | `codex` on `PATH`, `codex login` done | `agy` on `PATH`, signed in | `OPENROUTER_API_KEY` |
| Which models work | Any alias or id your Claude Code login accepts (`claude --help` lists the aliases under `--model`) | Slugs in your account's catalog: `codex debug models` prints them with the reasoning levels each supports | Ids from `agy models`. Most carry a fixed effort suffix (`gemini-3.8-flash-high`). The bare name (`gemini-3.8-flash`) takes its effort from the config instead. | Any id on [openrouter.ai/models](https://openrouter.ai/models) |
| `panelReasoning`, `judgeReasoning` | `low` to `max`, passed as `--effort`. `minimal` runs as `low`. | Levels the slug supports, passed as `-c model_reasoning_effort`. `minimal` runs as `low`. A level the slug lacks fails with the CLI's message. | `low`, `medium`, `high`, passed as `--effort`. `minimal` runs as `low`, `xhigh` and `max` as `high`. Ignored with a warning for an id that already ends in `-low`, `-medium` or `-high`. A level the bare model lacks fails with the CLI's message. | Any level, sent as `reasoning.effort`. If the model rejects it (HTTP 400) the call retries without reasoning and the report carries a warning. |
| `maxPanelOutputTokens`, `maxCompletionTokens` | Ignored. `claude -p` fails the whole call rather than truncating when a cap is hit, so panelists run under Claude Code's own limit. | Ignored, the CLI has no flag for it | Ignored, no flag | Applied as `max_tokens` |
| `temperature` | Ignored, no flag | Ignored, no flag | Ignored, no flag | Applied |
| `panelTools`, `maxToolCalls` | Applied | Ignored, text only | Ignored, text only | Ignored, text only |

OpenAI and Google models each have two routes, and the prefix is the whole choice. Nothing falls back from one to the other: a panel that lists `codex/gpt-5.5` on a machine without the CLI reports that panelist as failed and the rest of the panel runs. A panel may list both if you want the same model through both routes.

`agy` has no system-prompt flag, so the panel or judge instructions are sent at the top of the user message with a `---` separator. It also has nothing like Codex's `--ignore-user-config`, so each call runs under your Antigravity settings (`~/.gemini/antigravity-cli/settings.json`), including any MCP servers registered there. Skills and slash commands are turned off with `--disable-slash-commands`, and `--sandbox` restricts the terminal.

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
| `panelReasoning`, `judgeReasoning` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Which levels each backend honours is in the table above. |
| `maxPanelModels` | Cap on panel size, up to 8. |
| `maxPanelOutputTokens`, `maxCompletionTokens` | Output cap per panel call and per judge call. OpenRouter only. |
| `temperature` | OpenRouter only. |
| `panelTools` | `none`, `readonly` (`Read,Grep,Glob`), `all` (adds `Bash,Edit,Write`), or an explicit list. |
| `panelToolsConsent` | Must be `true` before `Bash`, `Edit` or `Write` are given to panelists. |
| `maxToolCalls` | Passed to `claude -p --max-turns`, so it bounds model turns rather than tool calls. A panelist that hits it is reported as capped and its last message becomes its answer. |
| `timeoutSeconds` | Per model call, default 600. A panelist that exceeds it fails with `timed out`. |

## Cost and time

Each fusion call is one model call per panelist plus one judge call. Claude panelists bill to your Claude Code login. Each one is a `claude -p` process started with `--system-prompt`, `--strict-mcp-config`, `--setting-sources ""` and a restricted tool list, so it does not load your plugins, skills, MCP servers or `CLAUDE.md`. A trivial call measured about 400 input tokens against roughly 39k for an unrestricted `claude -p`. Codex panelists bill to your ChatGPT subscription's Codex quota. Each one is a `codex exec` process started with `--ignore-user-config`, `--ignore-rules` and a replacement instructions file, so it skips your Codex config, MCP servers and the stock Codex system prompt. A trivial call measured just under 10k input tokens, most of it the CLI's built-in tool definitions, which have no flag. Antigravity panelists bill to your Google account's Antigravity quota. Each one is an `agy -p` process, and a trivial call measured about 13k input tokens, again mostly the CLI's built-in tools. OpenRouter panelists bill to your OpenRouter account at that model's rate.

Panelists run in parallel (up to four at once, one at a time when mutating tools are on). Wall time is roughly the slowest panelist plus the judge.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `No panel configured. Run /fusion-init to create .claude/fusion.json.` | No config found, or the panel list is empty or all ids are invalid. Run `/fusion-init` or check the ids (`claude/...`, `codex/...`, `agy/...` or `openrouter/vendor/model`). |
| `Cannot enable forced mode: ...` | Forced mode needs a resolvable panel. Fix the config first. |
| A panelist fails with `OPENROUTER_API_KEY is not set` | Export `OPENROUTER_API_KEY` in the shell that starts Claude Code, then restart it. |
| A panelist fails with `claude CLI not found on PATH`, `codex CLI not found on PATH` or `agy CLI not found on PATH` | The binary is not visible to the plugin's server process. Usually a PATH difference between your shell and the launcher. |
| A Codex panelist fails with `The '<model>' model is not supported when using Codex with a ChatGPT account` | Your plan does not offer that model in Codex. Pick one it does, or use `openrouter/openai/<model>` instead. |
| A Codex panelist fails with a login or authentication message | Run `codex login` in a terminal, then retry. |
| An Antigravity panelist fails with `invalid model selection` | The id is not in `agy models`, or the config's reasoning level is one the bare model lacks (`gemini-3.1-pro` only has `low` and `high`). Pick an id from the list, or use a suffixed id to pin the effort. |
| An Antigravity panelist fails with `You are not logged into Antigravity` | Run `agy` in a terminal and finish the browser sign-in, then retry. |
| A panelist fails with `OpenRouter 402 (insufficient credits)` or `429 (rate limited)` | Top up or wait. The rest of the panel still runs and the report lists the failure. |
| A panelist fails with `timed out` | Raise `timeoutSeconds` or lower the reasoning level for that model. |
| Report says `Judge analysis unavailable` | The judge errored or returned unparseable JSON. The panel responses are still in the report. Try a different judge or lower its reasoning. |
| Tool call is denied with "Fusion is off for this session" | You ran `/fusion off`. Run `/fusion available` or `/fusion on`. |
| Forced mode seems to do nothing | Check `/fusion-status` shows `Fusion mode: forced`. |
| Warning about mutating tools and a read-only subset | `panelTools` includes `Bash`, `Edit` or `Write` without `panelToolsConsent: true`. |

Modes and armed panels live in `~/.claude/claude-fusion/sessions/` (`FUSION_DATA_DIR` overrides the directory) and are keyed by session id. Deleting that directory resets every session to `available`.

## What is not ported from pi-fusion

Auto-diverse panel selection (OpenRouter models are not "authed", so auto-picking would spend money on arbitrary models), the footer status, the setup TUI, `context_mode: recent`, and tools for OpenRouter and Codex panelists.

## Development

`npm run check`, `npm test`, `npm run check:strict`, `npm run validate`. Design notes live in `docs/superpowers/specs/`.
