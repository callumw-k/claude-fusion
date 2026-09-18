# claude-fusion design

Port of [pi-fusion](https://github.com/synthetic-recon/pi-fusion) to a Claude Code plugin. A `fusion` tool runs a prompt against a panel of models in parallel, then a judge returns structured analysis (consensus, contradictions, partial coverage, unique insights, blind spots). Panel and judge are always user configuration, never chosen by the invoking model.

Source of the port: pi-fusion 0.9.1 at `/home/dev/code/active/pi-fusion`.

## 1. Scope

### In v1

- `fusion` MCP tool with the same params as pi-fusion minus `context_mode`/`context_turns`: `prompt` only.
- `fusion.json` config, global and project, with named panels, `defaultPanel`, per-panel and judge reasoning, temperature, token budgets, panel tool selection and consent.
- Two model backends: `claude/*` via `claude -p` on the user's Claude Code login, `openrouter/*` via the OpenRouter HTTP API.
- Judge on either backend. Structured output via `--json-schema` on the Claude backend, `extractJson` on OpenRouter.
- Session modes `available` (default), `forced`, `off`. `/fusion <prompt>` forces once. `/fusion <panel-name>` arms a named panel for the next fusion call.
- Panel tools for Claude panelists only: `readonly` = `Read,Grep,Glob`; `all` adds `Bash,Edit,Write` behind `panelToolsConsent` and serialises the panel.
- Commands `/fusion`, `/fusion-status`, `/fusion-report`, `/fusion-init`.
- Partial failure degradation and failure classification as in pi-fusion.
- Unit tests carried over where the code is carried over, plus tests for the new backend and state code.

### Deferred (v1.1 candidates)

- `context_mode: recent`. Hooks receive `transcript_path`, so it is feasible, but needs a transcript parser. The tool description tells the caller to put context in the prompt.
- `/fusion-setup` as an `AskUserQuestion`-driven skill.
- Panel tools for OpenRouter panelists (needs a hand-rolled tool loop).

### Out

- Auto-diverse panel selection. OpenRouter lists hundreds of models and none is "authed", so auto-selection would spend money on arbitrary models. A panel must be configured; `/fusion-init` writes a sensible default.
- Footer status. Plugins cannot install a statusline.
- The custom TUI.

## 2. Repository and plugin layout

```
claude-fusion/
├── .claude-plugin/
│   ├── plugin.json            name, version, description, mcpServers, hooks
│   └── marketplace.json       single-entry marketplace so `claude plugin marketplace add` works from the repo
├── .mcp.json                  fusion server: node src/server.ts
├── hooks/hooks.json           UserPromptSubmit, PreToolUse, SessionEnd → node src/cli.ts hook <event>
├── commands/
│   ├── fusion.md
│   ├── fusion-status.md
│   ├── fusion-report.md
│   └── fusion-init.md
├── src/
│   ├── server.ts              MCP entry: registers fusion + fusion_report tools
│   ├── cli.ts                 hook + command entry: state changes, status text, hook JSON
│   ├── backends/
│   │   ├── types.ts           Backend interface, ModelRef
│   │   ├── claude.ts          spawn claude -p
│   │   ├── openrouter.ts      fetch chat/completions, models cache
│   │   └── registry.ts        parse ids, pick backend, contextWindow lookup
│   ├── fusion.ts              copied, Model<Api> → ModelRef, llm calls → backend
│   ├── models.ts              copied minus ModelRegistry: candidate resolution over parsed ids
│   ├── config.ts              copied, paths changed, footerDisplay removed, timeoutSeconds added
│   ├── prompts.ts             copied
│   ├── format.ts              copied
│   ├── utils.ts               copied
│   ├── types.ts               copied, own ThinkingLevel, ModelRef replaces Model<Api>
│   ├── state.ts               per-session mode/armed-panel file
│   └── __tests__/             _harness.ts + suites
├── docs/superpowers/specs/
├── package.json               dependencies: @modelcontextprotocol/sdk, zod; dev: typescript
├── tsconfig.json              as pi-fusion plus erasableSyntaxOnly
├── AGENTS.md / CLAUDE.md
└── README.md
```

No build step. Node ≥ 22.18 strips types natively, so `.mcp.json` and hooks run `node src/*.ts`. Source uses `.ts` import extensions and erasable syntax only (no enums, no parameter properties). `npm run check` is `tsc --noEmit`; `npm test` runs `src/__tests__/*.test.ts` with plain `node`, no jiti.

Install for development: `claude --plugin-dir /home/dev/code/active/claude-fusion`. `claude plugin validate .` in CI.

## 3. Model identifiers and backends

A model id is `<backend>/<rest>`:

- `claude/<model>`: `<model>` is passed verbatim to `claude -p --model`, so aliases (`opus`, `sonnet`, `haiku`) and full ids both work.
- `openrouter/<vendor>/<model>`: `<vendor>/<model>` is the OpenRouter model id.

`registry.ts` exports `parseModelRef(id): ModelRef | undefined` and `modelDisplay(ref)` (the original string). Unknown backend prefix or an empty remainder is an "Unknown model identifier" warning, as in pi-fusion. There is no auth check at resolution time. Auth failures surface as per-model errors at call time and the existing degradation handles them.

```ts
interface ModelRef { backend: "claude" | "openrouter"; model: string; display: string }

interface CallOptions {
	systemPrompt: string;
	userText: string;
	maxTokens: number;
	temperature: number;
	reasoning?: ThinkingLevel;
	tools?: ToolName[];
	maxToolCalls: number;
	jsonSchema?: object;
	cwd: string;
	signal: AbortSignal;
}

interface CallResult { text: string; structured?: unknown; tools?: PanelToolUsage }

interface Backend {
	call(ref: ModelRef, options: CallOptions): Promise<CallResult>;
	contextWindow(ref: ModelRef): Promise<number>;
	supportsReasoning(ref: ModelRef, level: ThinkingLevel): { effective?: ThinkingLevel; warning?: string };
	supportsTools: boolean;
}
```

### Claude backend

Spawns `claude` with:

```
-p --output-format json --no-session-persistence
--model <model>
--system-prompt <systemPrompt>
--strict-mcp-config --mcp-config {"mcpServers":{}}
--setting-sources ""
--tools <list or "">
--allowedTools <same list>          only when tools non-empty
--permission-prompts none           only when tools non-empty
--max-turns <maxToolCalls>          only when tools non-empty
--effort <level>                    only when reasoning set
--json-schema <schema>              only when jsonSchema set
```

The prompt goes on stdin. `cwd` is the project directory. Measured in this session: the flag set above brings a haiku "pong" call from ~39k input tokens (full Claude Code system prompt, plugins, skills, MCP) down to 374. Every flag in that list is load-bearing for cost and must stay.

Output parsing: the JSON `result` object. `is_error: true` or a non-zero exit, or `subtype !== "success"`, throws with the `result` text (which carries auth/billing errors) so `classifyAllPanelFailure` can match on it. `structured_output` populates `CallResult.structured`. `num_turns` and `permission_denials` populate `PanelToolUsage` (`turns`, `capped = num_turns >= maxToolCalls`). Individual tool calls are not visible in `json` output, so `tool_calls` is empty for this backend and the report says so.

Reasoning: `minimal` maps to `low` with a warning; the other five pass through to `--effort`. Temperature is not settable and is silently omitted.

Tools: `readonly` → `Read,Grep,Glob`; `all` → `Read,Grep,Glob,Bash,Edit,Write`; an explicit list is filtered to those six names (pi's `find`/`ls` are accepted as aliases for `Glob` for config compatibility). `--max-turns` counts model turns, not tool calls, so `maxToolCalls` is an upper bound on turns. Documented in the README.

Cancellation: `signal` kills the child with SIGTERM. A `timeoutSeconds` config (default 600) aborts the signal per call.

Nested execution: verified in this session that `claude -p` runs from inside a Claude Code session with `CLAUDECODE` set and bills the subscription.

### OpenRouter backend

`POST https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer $OPENROUTER_API_KEY`, `HTTP-Referer` and `X-OpenRouter-Title: claude-fusion`. Body: `model`, `messages` (system + user), `max_tokens`, `temperature`, and `reasoning: { effort }` when set. No SDK; `fetch` is built in.

Missing `OPENROUTER_API_KEY` throws at call time with a message naming the variable. The key comes from the environment the MCP server inherits, or from the plugin's `userConfig` (`openrouter_api_key`) mapped into the server env in `.mcp.json`. Keys are never read from `fusion.json`.

Errors: non-2xx throws `OpenRouter <status>: <error.message>`; 402 and 429 wording is preserved so `classifyAllPanelFailure` classifies credits and rate limits. `finish_reason: "error"` or an empty `choices` array throws.

Reasoning: all six levels pass through. The backend does not pre-check support; if OpenRouter rejects `reasoning` for a model (400), the call is retried once without it and a warning is recorded on the result. Verify OpenRouter's actual behaviour for non-reasoning models during implementation and drop the retry if it just ignores the field.

`contextWindow` fetches `GET /api/v1/models` once per server process and caches `context_length` by id, falling back to 128 000 when the model is not listed or the fetch fails.

`supportsTools` is false. A panel with tools enabled runs OpenRouter panelists without tools and records a warning per model, matching pi-fusion's fail-closed style.

## 4. Configuration

Paths, in precedence order: `<project>/.claude/fusion.json`, then `~/.claude/fusion.json`. The pi "project trusted" gate is dropped; Claude Code has its own workspace trust and a `-p` run already reads project settings. The project directory comes from `CLAUDE_PROJECT_DIR` (set in `.mcp.json` env from `${CLAUDE_PROJECT_DIR}`) with `process.cwd()` as fallback.

Schema is pi-fusion's `FusionConfig` with these changes:

- `footerDisplay` removed.
- `timeoutSeconds` added (default 600), per model call.
- `panel` is required in practice: with no resolvable panel the tool returns `status: "error"` with `error: "No panel configured. Run /fusion-init."` rather than auto-selecting.
- `panelToolsConsent` is the only consent path (no UI prompt).

`generateConfigExample` writes:

```json
{
  "defaultPanel": "default",
  "panels": {
    "default": {
      "models": ["claude/opus", "openrouter/openai/gpt-5.5", "openrouter/google/gemini-3-pro"],
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

Exact OpenRouter ids in the example are checked against `/api/v1/models` at implementation time.

`config.ts`'s `loadConfig`, `parseFusionConfig`, `applyDefaults`, `resolveEffectiveConfig` and the named-panel validation carry over unchanged apart from the path and field changes above.

## 5. Pipeline

`fusion.ts` is copied with mechanical substitutions:

- `Model<Api>` → `ModelRef`; `ModelRegistry` → the backend registry; `ExtensionContext` removed.
- `callModelText` / `callModelWithTools` → `backend.call(ref, options)`. `toolsEnabled` is decided per model: `backend.supportsTools && toolDefs.length > 0`.
- `resolveModelReasoning` → `backend.supportsReasoning`.
- Judge: `jsonSchema` is passed with the `FusionAnalysis` JSON Schema. If `CallResult.structured` is present it goes straight to `parseFusionAnalysis`; otherwise `extractJson(text)` as now.
- Judge budget uses `await backend.contextWindow(judge)`.
- `resolvePanelAndJudge` (in `models.ts`) keeps the candidate walk (`explicit` → `session` → `default` → `legacy`) and warnings, drops `hasConfiguredAuth` and the `currentModel` fallback, and replaces the `auto` step with the "No panel configured" error.
- `runFusion` signature loses `cwd`/`registry`/`ctx`; it takes `{ projectDir, config, backends, overrides, consented, signal, onProgress }`.
- `PanelSelectionError` loses its constructor parameter properties (explicit field declarations instead), since Node's type stripping rejects non-erasable syntax. `tsc` enforces this via `erasableSyntaxOnly`.

`compactFusionToolText`, `emptyPanelError`, `parseFusionAnalysis`, `classifyAllPanelFailure`, `prompts.ts`, `format.ts`, `utils.ts` are unchanged. `context.ts` is not carried over; `buildFusionTaskText(prompt, undefined)` collapses to the prompt, so `fusion.ts` uses the prompt directly.

Concurrency is `PANEL_CONCURRENCY = 4`, or 1 when mutating tools are enabled, as now.

## 6. MCP server

`server.ts` uses `McpServer` from `@modelcontextprotocol/sdk` over stdio and registers:

- `fusion` with `{ prompt: string }`. Description and guidelines are pi-fusion's, with the `context_mode` sentence replaced by "Panel and judge calls do not see the conversation. Put any context the panel needs into the prompt." Returns the compact JSON text as the tool result. On `status: "error"` the result is marked `isError`.
- `fusion_report` with `{ prompt: string }`. Same run, returns `formatResult(...)` markdown for `/fusion-report`.

Both tools read session state first (section 7). Mode `off` returns `{ status: "error", error: "fusion disabled" }`. An armed named panel is consumed (cleared from the state file before the run starts) and passed as `panel_profile`.

Progress: the pi `onUpdate` messages ("Fusion panel: …", "Panel complete (n/m). Running judge…") are sent as MCP `notifications/progress` when the client supplied a progress token, otherwise dropped. Cancellation: the SDK's request `signal` is passed through to backends.

The server logs to stderr only. Stdout is the MCP transport.

## 7. Session state, hooks and commands

### State file

`${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json`:

```json
{ "mode": "available" | "forced" | "off", "armedPanel": "name" }
```

Absent file means `available` with nothing armed. `state.ts` exposes `readState(sessionId)`, `writeState(sessionId, patch)`, `clearState(sessionId)`, and `consumeArmedPanel(sessionId)`.

Session id sources:

- Hooks: `session_id` from stdin.
- Commands: the `!` inline script runs inside the session; it reads `CLAUDE_CODE_SESSION_ID` from its environment.
- MCP server: `CLAUDE_CODE_SESSION_ID` from its environment.

`CLAUDE_CODE_SESSION_ID` is present in this session's Bash environment. Whether Claude Code also sets it for the MCP server process and for `!` command expansion is the first thing to verify during implementation. Fallback if it is not: the `UserPromptSubmit` hook writes `${CLAUDE_PLUGIN_DATA}/current-session` with its `session_id` on every prompt, and the server and CLI read that file when the env var is absent. Concurrent sessions then share the most recently prompted session's state; the README documents this.

`SessionEnd` hook deletes the session file.

### Hooks (`hooks/hooks.json`)

All hooks are `{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/src/cli.ts", "hook", "<event>"] }`.

- `UserPromptSubmit`: read state. If `mode !== "forced"`, exit 0 with no output. If the prompt starts with `/` or already starts with the force preamble, exit 0. Otherwise output `hookSpecificOutput.updatedInput.prompt` set to pi-fusion's `forceFusionPrompt(prompt)` without the `context_mode` line.
- `PreToolUse` with matcher `mcp__plugin_claude_fusion_fusion__fusion|mcp__plugin_claude_fusion_fusion__fusion_report` (exact scoped names confirmed at implementation): if `mode === "off"`, output `permissionDecision: "deny"` with reason "Fusion is off for this session. Use /fusion available or /fusion on to re-enable it."
- `SessionEnd`: `clearState(session_id)`.

A hook that cannot read its state file exits 0 silently. Hooks never block on error.

### Commands (`commands/*.md`)

Each command's body starts with an inline script, then a one-line instruction. Example `fusion.md`:

```
---
description: "Fusion mode: /fusion on | available | off, /fusion <panel-name> arms a panel once, /fusion <prompt> forces one fusion call"
argument-hint: "[on|available|off|<panel-name>|<prompt>]"
---
!node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" fusion "$ARGUMENTS"

Follow the instruction printed above exactly. If it contains a prompt to run, call the fusion tool with that prompt, then answer the user in your own words without pasting the raw JSON.
```

`cli.ts fusion <args>` decides, in this order, mirroring pi-fusion's `/fusion` handler:

1. Empty: toggle `available` ↔ `forced`. `forced` requires a resolvable panel (`resolveFusionSelection` with no overrides succeeds); otherwise print the error and leave the mode alone.
2. `on|force|forced`, `available|auto`, `off|disable|disabled`: set the mode. Same panel check for forced.
3. A configured named panel name: arm it. Print "Named panel X armed for the next fusion call."
4. Anything else: if mode is `off`, print "Fusion is off…". Otherwise print `Run the fusion tool with this prompt: <args>`.

`fusion-status.md` runs `cli.ts status`, which prints the mode, the resolved panel/judge/reasoning/tools from config, warnings, and the config file path in use. `fusion-init.md` runs `cli.ts init`, which writes `.claude/fusion.json` in the project when absent and prints the path, or prints the existing path and the example JSON if the file exists (no overwrite, no prompt). `fusion-report.md` has no inline script; it instructs Claude to call `fusion_report` with `$ARGUMENTS` and print the returned markdown verbatim.

## 8. Error handling

Unchanged from pi-fusion at the pipeline level: a panelist that throws becomes `failed_models[]`; one success skips the judge; zero successes returns `status: "error"` with `failure_reason` from `classifyAllPanelFailure`; judge failure or unparseable JSON leaves `analysis` undefined with a warning.

Backend-specific:

- Claude: `claude` not on `PATH` throws "claude CLI not found" for that model. Exit code 143 (SIGTERM from cancellation) throws "cancelled".
- OpenRouter: missing key, HTTP errors, network errors as in section 3. `AbortSignal` aborts the fetch.
- Config parse errors log to stderr and fall through to the next path, as now.

The MCP server never crashes on a tool error; every `execute` catches and returns `status: "error"` with `failure_reason: "unexpected_error"`.

## 9. Testing

Test runner is pi-fusion's `_harness.ts` (`test`, `eq`) run by plain `node`. `fakeModel` is replaced by `fakeRef(id)` and a `FakeBackend` that records calls and returns scripted results.

Carried over and adapted: `config.test.ts`, `format.test.ts`, `fusion.test.ts` (degradation paths, consent stripping, judge parsing, single-success skip), `models.test.ts` (candidate walk, warnings, no-panel error), `utils.test.ts`.

New:

- `registry.test.ts`: id parsing, display, unknown prefix, empty remainder.
- `claude.test.ts`: argument builder (flag set per tools/reasoning/schema combination, `minimal` → `low` warning), result parsing (`is_error`, `subtype`, `structured_output`, `num_turns` → capped).
- `openrouter.test.ts`: request body builder (reasoning present/absent, temperature), response parsing, 402/429 error text, empty choices, reasoning-rejected retry.
- `state.test.ts`: read/write/consume/clear, missing file, corrupt file.
- `cli.test.ts`: `/fusion` argument dispatch (toggle, set, arm, prompt, off-blocks-prompt), forced-prompt hook skip rules.

Not tested: MCP wiring, process spawning, hook JSON envelope (thin and verified by hand with `--plugin-dir`).

## 10. Verification checklist for implementation

Things this spec assumes that must be confirmed in the first implementation step, with the fallback if false:

1. `CLAUDE_CODE_SESSION_ID` is set in the MCP server's and `!` command's environment. Fallback: `current-session` pointer file (section 7).
2. `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS` both expand inside a `!` line in `commands/*.md`. Fallback: an MCP tool `fusion_set_mode` called by the command markdown.
3. Scoped tool name format for the `PreToolUse` matcher.
4. `claude -p --json-schema` works together with `--system-prompt` and `--tools ""`.
5. OpenRouter behaviour when `reasoning` is sent to a non-reasoning model.
6. The default panel's OpenRouter ids exist.

## 11. Dependencies and versions

- `@modelcontextprotocol/sdk` (latest 1.x) and `zod` (its peer). Nothing else at runtime.
- `typescript` dev only. No jiti, no test framework.
- Node ≥ 22.18. Claude Code ≥ 2.1.259 (`--permission-prompts`). Both noted in README and `package.json` `engines`.
- Licence MIT, matching pi-fusion. README credits pi-fusion and OpenRouter Fusion.
