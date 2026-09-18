# claude-fusion

Multi-model deliberation for Claude Code. The `fusion` tool runs a prompt against a panel of models in parallel, then a judge compares the answers and returns structured analysis: consensus, contradictions, partial coverage, unique insights and blind spots. A port of [pi-fusion](https://github.com/synthetic-recon/pi-fusion), itself inspired by OpenRouter Fusion.

## Requirements

- Claude Code 2.1.259 or later
- Node 22.18 or later (the plugin runs TypeScript directly, there is no build)
- `OPENROUTER_API_KEY` exported in the shell that launches Claude Code, for any `openrouter/*` model

## Install

```
git clone https://github.com/callumw-k/claude-fusion ~/code/claude-fusion
cd ~/code/claude-fusion && npm install
claude --plugin-dir ~/code/claude-fusion
```

Or add it as a marketplace: `claude plugin marketplace add callumw-k/claude-fusion` then `claude plugin install claude-fusion`. A marketplace install runs `npm ci --ignore-scripts` for you because the repo ships a `package-lock.json`, so `npm install` is only needed for a `--plugin-dir` checkout.

## Configure

`/fusion-init` writes `.claude/fusion.json` in the project. `~/.claude/fusion.json` is the global fallback. The project file wins when both exist. A project file can set `panelToolsConsent` too, so review it in cloned repos before enabling `all`.

Model ids carry their backend:

- `claude/<model>`: runs `claude -p` on your Claude Code login. `opus`, `sonnet`, `haiku` and full ids all work. These panelists can use tools.
- `openrouter/<vendor>/<model>`: the OpenRouter model id, e.g. `openrouter/openai/gpt-5.5`. Text only.

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
| `panels`, `defaultPanel` | Named panels. `panel` and `judge` at the top level are the legacy fallback. |
| `panelReasoning`, `judgeReasoning` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Claude models run `minimal` as `low`. |
| `maxPanelOutputTokens`, `maxCompletionTokens` | OpenRouter models only. Claude panelists and judges run under Claude Code's own output limit, because `claude -p` fails the whole call rather than truncating when a cap is exceeded, and thinking shares that budget. |
| `temperature` | OpenRouter models only. `claude -p` does not accept one. |
| `panelTools` | `none`, `readonly` (`Read,Grep,Glob`), `all` (adds `Bash,Edit,Write`), or a list. Claude panelists only. |
| `panelToolsConsent` | Must be `true` for `all` or any list containing `Bash`, `Edit` or `Write`. Mutating panels run one model at a time. |
| `maxToolCalls` | Passed to `claude -p --max-turns`, so it bounds model turns rather than individual tool calls. A panelist that reaches the bound is reported as capped: its last message is used as its answer, or it fails with "no text answer" if it had not spoken yet. |
| `timeoutSeconds` | Per model call. |

## Use

- The model calls `fusion` itself when a question warrants several perspectives. The tool takes only a prompt. Panel and judge are always yours to configure.
- `/fusion` toggles between `available` and `forced`. In forced mode a hook attaches an instruction to every plain prompt telling Claude to call fusion before answering.
- `/fusion on | available | off`. Off denies the tool for the session.
- `/fusion <panel-name>` arms a named panel for the next fusion call. A panel named `on`, `off`, `available`, `auto`, `force`, `forced`, `disable` or `disabled` cannot be armed this way, because those words set the mode.
- `/fusion <prompt>` runs fusion once on that prompt.
- `/fusion-report <prompt>` prints the full report: the analysis plus every panel response.
- `/fusion-status` shows the mode, config file, resolved panel and judge.

The `/fusion <prompt>` text reaches the plugin through a quoted heredoc, so quotes, backticks and `$` in the prompt are passed through literally and never expanded by the shell.

When the plugin is loaded with `--plugin-dir`, the commands are namespaced: use `/claude-fusion:fusion`, `/claude-fusion:fusion-status` and so on if the bare names do not resolve.

## How the Claude backend keeps costs down

Each Claude panelist is a `claude -p` call with `--system-prompt`, `--strict-mcp-config`, `--setting-sources ""` and `--tools` restricted, so it does not load your plugins, skills, MCP servers or `CLAUDE.md`. Measured: a trivial call drops from about 39k input tokens to under 400.

## Session state

Modes and armed panels are stored per session in `~/.claude/claude-fusion/sessions/` (override the directory with `FUSION_DATA_DIR`). The server reads `CLAUDE_CODE_SESSION_ID` directly, falling back to a `current-session` pointer file only when that variable is not set.

## What is not ported from pi-fusion

Auto-diverse panel selection (OpenRouter models are not "authed", so auto-picking would spend money on arbitrary models), the footer status, the setup TUI, `context_mode: recent`, and tools for OpenRouter panelists.

## Development

`npm run check`, `npm test`, `npm run check:strict`, `npm run validate`. Design notes live in `docs/superpowers/specs/`.
