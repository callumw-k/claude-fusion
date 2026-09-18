# claude-fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (superpowers:executing-plans only where subagents are unavailable). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin that runs a prompt against a configured panel of models (Claude via `claude -p`, everything else via OpenRouter) and returns a judge's structured comparison, with session modes, named panels, and diagnostic reports.

**Architecture:** One Node MCP server (`src/server.ts`) exposes `fusion` and `fusion_report`; a CLI entry (`src/cli.ts`) backs the hooks and slash commands; both share a core copied from pi-fusion (`fusion.ts`, `config.ts`, `models.ts`, `prompts.ts`, `format.ts`, `utils.ts`) with a `Backend` interface replacing pi's model registry and `complete()`. Session state is a JSON file per session id.

**Tech Stack:** TypeScript run directly by Node ≥ 22.18 (native type stripping, no build), `@modelcontextprotocol/sdk` 1.x + `zod`, Claude Code plugin manifest (`.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `commands/*.md`).

**Spec:** `docs/superpowers/specs/2026-09-18-claude-fusion-design.md`

**Execution:** waves

## Global Constraints

- Node ≥ 22.18.0. Source must be erasable-syntax only (no `enum`, no constructor parameter properties, no `namespace`); `tsconfig.json` sets `"erasableSyntaxOnly": true`. All relative imports use the `.ts` extension.
- Runtime dependencies: exactly `@modelcontextprotocol/sdk` (1.x) and `zod`. Dev: `typescript`, `@types/node`. Nothing else.
- Tabs for indentation, semicolons, double quotes, matching pi-fusion. No code comments unless deleting one would make a reader wrong. Copied pi-fusion comments may stay.
- Docs and user-facing strings in Australian/British English, plain punctuation (no em dashes, no semicolons in prose).
- Source of copied code: `/home/dev/code/active/pi-fusion/src/`. Copy by reading that file and applying the listed edits; never import from pi packages.
- Session state lives in `~/.claude/claude-fusion/` (override with `FUSION_DATA_DIR`), not `${CLAUDE_PLUGIN_DATA}`, because placeholder expansion inside `commands/*.md` is unverified and the CLI must find the same directory from hooks, commands and the server.
- The Claude backend must always pass the trimmed flag set from the spec (`--system-prompt`, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, `--setting-sources ""`, `--tools ...`, `--no-session-persistence`). Every flag is load-bearing for token cost.
- Commit messages: one imperative subject line ≤ 72 chars, no body unless needed, no `Co-Authored-By` or Claude/Anthropic references.
- Commands: `npm run check` (tsc), `npm run check:strict` (tsc with unused checks), `npm test` (all suites), `node src/__tests__/<name>.test.ts` (one suite).

---

### Task 1: Repository scaffold and utilities

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`
- Create: `src/utils.ts`, `src/__tests__/_harness.ts`, `src/__tests__/utils.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `test(name, fn)`, `eq(a, b, msg)` from `_harness.ts`; `mapWithConcurrencyLimit`, `truncateToBytes`, `extractJson` from `utils.ts` (identical to pi-fusion)

**Depends on:** none

- [ ] **Step 1: Write package.json**

```json
{
	"name": "claude-fusion",
	"version": "0.1.0",
	"description": "Multi-model deliberation plugin for Claude Code, ported from pi-fusion",
	"type": "module",
	"private": true,
	"license": "MIT",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/callumw-k/claude-fusion.git"
	},
	"engines": {
		"node": ">=22.18.0"
	},
	"scripts": {
		"check": "tsc --noEmit",
		"check:strict": "tsc --noEmit --noUnusedLocals --noUnusedParameters",
		"test": "for f in src/__tests__/*.test.ts; do node \"$f\" || exit 1; done",
		"validate": "claude plugin validate ."
	},
	"dependencies": {
		"@modelcontextprotocol/sdk": "^1.29.0",
		"zod": "^3.25.0"
	},
	"devDependencies": {
		"@types/node": "^22.0.0",
		"typescript": "^5.8.0"
	}
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"strict": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"noEmit": true,
		"resolveJsonModule": true,
		"allowImportingTsExtensions": true,
		"erasableSyntaxOnly": true,
		"types": ["node"]
	},
	"include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write .gitignore, LICENSE, AGENTS.md, CLAUDE.md**

`.gitignore`:

```
node_modules/
.superpowers/
.worktrees/
```

`LICENSE`: copy `/home/dev/code/active/pi-fusion/LICENSE` and add a second copyright line `Copyright (c) 2026 callumw-k` under the existing one.

`CLAUDE.md`:

```markdown
# CLAUDE.md

@AGENTS.md
```

`AGENTS.md`:

```markdown
# AGENTS.md

claude-fusion is a Claude Code plugin: a `fusion` MCP tool runs a prompt against a panel of models in parallel, then a judge returns structured analysis. Ported from pi-fusion. Design: `docs/superpowers/specs/2026-09-18-claude-fusion-design.md`.

## Commands

- `npm run check` type-checks. There is no build step: Node ≥ 22.18 strips types natively, so `.mcp.json` and hooks run `node src/*.ts` directly. Source must stay erasable-syntax only (`erasableSyntaxOnly` in tsconfig).
- `npm test` runs every `src/__tests__/*.test.ts` with plain `node`. The runner is `src/__tests__/_harness.ts` (`test`, `eq`); there is no jest/vitest. One suite: `node src/__tests__/<name>.test.ts`.
- `npm run check:strict` catches unused imports and locals. Run it before finishing a change.
- `npm run validate` runs `claude plugin validate .`.
- Try it live: `npm install`, then `claude --plugin-dir /abs/path/to/claude-fusion`. `/reload-plugins` after edits.

## Architecture

- `src/server.ts` is the MCP entry (tools `fusion`, `fusion_report`). `src/cli.ts` is the entry for hooks and slash commands (`hook <event>`, `fusion <args>`, `status`, `init`).
- `src/fusion.ts` `runFusion` is the pipeline: resolve panel and judge (`models.ts`) → run the panel through `backends/*` concurrently (`utils.ts` `mapWithConcurrencyLimit`) → judge → `FusionDetails` (`types.ts`). `format.ts` renders the report.
- `src/backends/` has one implementation per model id prefix: `claude/*` spawns `claude -p` (`claude.ts`), `openrouter/*` calls the OpenRouter HTTP API (`openrouter.ts`). `registry.ts` parses ids. The `Backend` interface is in `backends/types.ts`.
- `src/config.ts` reads `<project>/.claude/fusion.json` then `~/.claude/fusion.json`. Panel and judge are always user configuration; the `fusion` tool exposes only `prompt`.
- `src/state.ts` keeps per-session mode (`available`/`forced`/`off`) and an armed named panel in `~/.claude/claude-fusion/sessions/<session_id>.json` (`FUSION_DATA_DIR` overrides the directory). Hooks get the session id from stdin; the server and commands read `CLAUDE_CODE_SESSION_ID`, falling back to the `current-session` pointer the `UserPromptSubmit` hook writes.

## Conventions

- Tabs, double quotes, `.ts` import extensions. Keep the runtime dependency list to the MCP SDK and zod.
- Verify MCP SDK and Claude Code plugin APIs against the installed `.d.ts` and the docs at code.claude.com before using them.
```

- [ ] **Step 4: Install dependencies**

Run: `cd /home/dev/code/active/claude-fusion && npm install`
Expected: `node_modules/@modelcontextprotocol/sdk`, `node_modules/zod`, `node_modules/typescript` exist. Commit `package-lock.json`.

- [ ] **Step 5: Write the test harness**

`src/__tests__/_harness.ts`:

```ts
export function test(name: string, fn: () => void | Promise<void>) {
	try {
		Promise.resolve(fn()).then(
			() => console.log(`✓ ${name}`),
			(err) => {
				console.error(`✗ ${name}:`, err);
				process.exitCode = 1;
			},
		);
	} catch (err) {
		console.error(`✗ ${name}:`, err);
		process.exitCode = 1;
	}
}

export function eq<T>(a: T, b: T, msg: string) {
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
	}
}
```

- [ ] **Step 6: Copy utils and its test**

Copy `/home/dev/code/active/pi-fusion/src/utils.ts` to `src/utils.ts` verbatim, replacing the header comment `General utilities for pi-fusion.` with `General utilities for claude-fusion.`

Copy `/home/dev/code/active/pi-fusion/src/__tests__/utils.test.ts` to `src/__tests__/utils.test.ts` verbatim, replacing `Tests for pi-fusion utilities.` with `Tests for claude-fusion utilities.`

- [ ] **Step 7: Run check and tests**

Run: `npm run check && npm test`
Expected: tsc clean; 8 lines starting with `✓`, exit 0.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore LICENSE AGENTS.md CLAUDE.md src
git commit -m "Scaffold claude-fusion with test harness and utils"
```

---

### Task 2: Types, prompts and report formatting

**Files:**
- Create: `src/types.ts`, `src/prompts.ts`, `src/format.ts`
- Test: `src/__tests__/format.test.ts`

**Interfaces:**
- Consumes: `truncateToBytes` from `utils.ts`
- Produces: every type below; `PANEL_SYSTEM_PROMPT`, `PANEL_SYSTEM_PROMPT_WITH_TOOLS`, `JUDGE_SYSTEM_PROMPT`, `FUSION_ANALYSIS_SCHEMA: Record<string, unknown>`, `truncateForJudge(text, maxBytes)`; `formatAnalysis(analysis)`, `formatResult(details: FusionDetails): string`

**Depends on:** Task 1

- [ ] **Step 1: Write src/types.ts**

```ts
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type BackendName = "claude" | "openrouter";

export interface ModelRef {
	backend: BackendName;
	model: string;
	display: string;
}

export type ToolMode = "none" | "readonly" | "all";
export type ToolSelection = ToolMode | string[];
export type FusionMode = "available" | "forced" | "off";

export interface NamedPanelConfig {
	models: string[];
	judge?: string;
	panelReasoning?: ThinkingLevel;
	judgeReasoning?: ThinkingLevel;
}

export interface FusionConfig {
	/** Explicit panel model identifiers, e.g. ["claude/opus", "openrouter/openai/gpt-5.5"]. */
	panel?: string[];
	judge?: string;
	panels?: Record<string, NamedPanelConfig>;
	defaultPanel?: string;
	panelReasoning?: ThinkingLevel;
	judgeReasoning?: ThinkingLevel;
	/** Max panel models (1–8). */
	maxPanelModels?: number;
	maxPanelOutputTokens?: number;
	maxCompletionTokens?: number;
	/** Sampling temperature; only OpenRouter models honour it. */
	temperature?: number;
	/** Panel tool access: "none" (default), "readonly", "all", or an explicit tool-name list. Claude panelists only. */
	panelTools?: ToolSelection;
	/** Max agentic turns per Claude panelist (1–100, default 16). */
	maxToolCalls?: number;
	/** Consent for mutating tools (Bash/Edit/Write). */
	panelToolsConsent?: boolean;
	/** Per model call timeout (default 600). */
	timeoutSeconds?: number;
}

export type ResolvedFusionConfig = FusionConfig & {
	maxPanelModels: number;
	maxPanelOutputTokens: number;
	maxCompletionTokens: number;
	temperature: number;
	maxToolCalls: number;
	timeoutSeconds: number;
};

export type ConfigSelectionSource = "explicit" | "default" | "legacy";
export type ConfigSelectionErrorCode = "unknown_named_panel" | "invalid_named_panel";

export interface ConfigSelectionError {
	code: ConfigSelectionErrorCode;
	panelName: string;
	message: string;
}

export type EffectiveConfigResult =
	| {
		ok: true;
		config: ResolvedFusionConfig;
		profileName?: string;
		source: ConfigSelectionSource;
		warnings: string[];
	}
	| {
		ok: false;
		error: ConfigSelectionError;
		warnings: string[];
	};

export interface PanelResult {
	model: string;
	content: string;
	error?: string;
	tools?: PanelToolUsage;
}

export interface FusionAnalysis {
	consensus: string[];
	contradictions: Array<{ topic: string; stances: Array<{ model: string; stance: string }> }>;
	partial_coverage: Array<{ models: string[]; point: string }>;
	unique_insights: Array<{ model: string; insight: string }>;
	blind_spots: string[];
}

export interface FusionOptions {
	/** Named panel armed by /fusion <name>. Never exposed on the tool schema. */
	panel_profile?: string;
}

export interface PanelToolUsage {
	turns: number;
	tool_calls: Array<{ name: string; ok: boolean }>;
	capped: boolean;
}

export interface FusionResult {
	content: Array<{ type: "text"; text: string }>;
	details: FusionDetails;
}

export interface FusionDetails {
	status: "ok" | "error";
	analysis?: FusionAnalysis;
	responses: Array<{ model: string; content: string; tools?: PanelToolUsage }>;
	failed_models?: Array<{ model: string; error: string; tools?: PanelToolUsage }>;
	panel_models?: string[];
	judge_model?: string;
	panel_profile?: string;
	panel_reasoning?: { requested: ThinkingLevel; effective: Record<string, ThinkingLevel | null> };
	judge_reasoning?: { requested: ThinkingLevel; effective: ThinkingLevel | null };
	panel_tools?: { mode: string; max_tool_calls: number; serialized: boolean };
	warnings?: string[];
	error?: string;
	failure_reason?: "all_panels_failed" | "insufficient_credits" | "rate_limited" | "unexpected_error";
}
```

- [ ] **Step 2: Write src/prompts.ts**

Copy `/home/dev/code/active/pi-fusion/src/prompts.ts` verbatim (change the header to `System prompts and prompt utilities for claude-fusion.`), then append:

```ts
export const FUSION_ANALYSIS_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		consensus: { type: "array", items: { type: "string" } },
		contradictions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					topic: { type: "string" },
					stances: {
						type: "array",
						items: {
							type: "object",
							properties: { model: { type: "string" }, stance: { type: "string" } },
							required: ["model", "stance"],
						},
					},
				},
				required: ["topic", "stances"],
			},
		},
		partial_coverage: {
			type: "array",
			items: {
				type: "object",
				properties: { models: { type: "array", items: { type: "string" } }, point: { type: "string" } },
				required: ["models", "point"],
			},
		},
		unique_insights: {
			type: "array",
			items: {
				type: "object",
				properties: { model: { type: "string" }, insight: { type: "string" } },
				required: ["model", "insight"],
			},
		},
		blind_spots: { type: "array", items: { type: "string" } },
	},
	required: ["consensus", "contradictions", "partial_coverage", "unique_insights", "blind_spots"],
};
```

- [ ] **Step 3: Write the failing format test**

`src/__tests__/format.test.ts`:

```ts
import { formatAnalysis, formatResult } from "../format.ts";
import type { FusionAnalysis, FusionDetails } from "../types.ts";
import { test } from "./_harness.ts";

test("formatAnalysis includes all sections", () => {
	const analysis: FusionAnalysis = {
		consensus: ["agreed"],
		contradictions: [{ topic: "t", stances: [{ model: "a/m", stance: "yes" }] }],
		partial_coverage: [{ models: ["a/m"], point: "p" }],
		unique_insights: [{ model: "a/m", insight: "i" }],
		blind_spots: ["missing"],
	};
	const text = formatAnalysis(analysis);
	for (const header of ["Consensus", "Contradictions", "Partial Coverage", "Unique Insights", "Blind Spots"]) {
		if (!text.includes(header)) throw new Error(`missing ${header}`);
	}
});

test("formatResult includes panel metadata, failures and raw responses", () => {
	const details: FusionDetails = {
		status: "ok",
		responses: [{ model: "claude/opus", content: "hello" }],
		failed_models: [{ model: "openrouter/x/y", error: "OpenRouter 429 (rate limited): slow down" }],
		panel_models: ["claude/opus", "openrouter/x/y"],
		judge_model: "claude/sonnet",
	};
	const result = formatResult(details);
	for (const needle of ["claude/opus", "claude/sonnet", "openrouter/x/y (OpenRouter 429", "### claude/opus\nhello", "Only one panel model"]) {
		if (!result.includes(needle)) throw new Error(`missing ${needle} in:\n${result}`);
	}
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `node src/__tests__/format.test.ts`
Expected: module not found error for `../format.ts`.

- [ ] **Step 5: Write src/format.ts**

Copy `/home/dev/code/active/pi-fusion/src/format.ts` and replace everything from `export function formatResult(` to the end of the file with:

```ts
export function formatResult(details: FusionDetails): string {
	const responses = details.responses;
	const failed = details.failed_models ?? [];
	const lines: string[] = [];
	lines.push(`# Fusion Analysis (${responses.length} panel model${responses.length === 1 ? "" : "s"})`);
	lines.push(`*Panel: ${(details.panel_models ?? []).join(", ")} | Judge: ${details.judge_model ?? "unknown"}*`);

	if (failed.length > 0) {
		lines.push("\n**Failed models:** " + failed.map((f) => `${f.model} (${f.error})`).join("; "));
	}

	if (responses.length < 2) {
		lines.push("\n*Only one panel model produced a response. Skipping multi-model synthesis; see the raw response below.*");
	} else if (details.analysis) {
		lines.push("\n" + formatAnalysis(details.analysis));
	} else {
		lines.push("\n*Judge analysis unavailable. See raw panel responses below.*");
	}

	lines.push("\n## Panel Responses");
	for (const r of responses) {
		lines.push(`\n### ${r.model}\n${r.content}`);
	}

	return lines.join("\n");
}
```

Change the import line to `import type { FusionAnalysis, FusionDetails } from "./types.ts";`.

- [ ] **Step 6: Run check and tests**

Run: `npm run check && node src/__tests__/format.test.ts`
Expected: both tests `✓`.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/prompts.ts src/format.ts src/__tests__/format.test.ts
git commit -m "Add shared types, prompts and report formatting"
```

---

### Task 3: Configuration loading

**Files:**
- Create: `src/config.ts`
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `FusionConfig`, `ResolvedFusionConfig`, `EffectiveConfigResult`, `NamedPanelConfig`, `ConfigSelectionError`, `ThinkingLevel` from `types.ts`
- Produces: constants `DEFAULT_MAX_PANEL_MODELS = 3`, `DEFAULT_MAX_PANEL_OUTPUT_TOKENS = 2048`, `DEFAULT_MAX_COMPLETION_TOKENS = 4096`, `DEFAULT_TEMPERATURE = 0.3`, `MAX_PANEL_MODELS_HARD_LIMIT = 8`, `PANEL_CONCURRENCY = 4`, `DEFAULT_MAX_TOOL_CALLS = 16`, `MIN_TOOL_CALLS = 1`, `MAX_TOOL_CALLS = 100`, `DEFAULT_TIMEOUT_SECONDS = 600`, `THINKING_LEVELS`; functions `configPaths(projectDir): string[]`, `loadConfigWithPath(projectDir): { config: FusionConfig; path?: string }`, `loadConfig(projectDir): FusionConfig`, `parseFusionConfig(text)`, `applyDefaults(config): ResolvedFusionConfig`, `resolveEffectiveConfig(config, explicitPanel?): EffectiveConfigResult`, `generateConfigExample(): FusionConfig`

**Depends on:** Task 2

- [ ] **Step 1: Write the failing config test**

Copy `/home/dev/code/active/pi-fusion/src/__tests__/config.test.ts` to `src/__tests__/config.test.ts`, then apply these edits:

1. Header comment: `Tests for named-panel config selection and defaults.`
2. Every `resolveEffectiveConfig(X, {}, Y)` becomes `resolveEffectiveConfig(X, Y)` (occurrences with `"fast"`, `"missing"`, `name`, `"explicit"`).
3. Delete the test `"effective selection preserves applyDefaults overrides and numeric config"` entirely.
4. Replace the test `"applyDefaults remains backward compatible when called directly"` with:

```ts
test("applyDefaults fills every numeric knob including timeoutSeconds", () => {
	const result = applyDefaults({ panel: ["claude/opus"] });
	eq(result.panel, ["claude/opus"], "panel retained");
	eq(result.timeoutSeconds, 600, "timeout default");
	eq(result.maxToolCalls, 16, "tool call default");
	eq(applyDefaults({ timeoutSeconds: 30 }).timeoutSeconds, 30, "configured timeout retained");
});
```

5. Replace the test `"generated config uses a resolvable named default panel"` with:

```ts
test("generated config uses a resolvable named default panel with both backends", () => {
	const example = generateConfigExample();
	eq(example.defaultPanel, "default", "generated config names its default panel");
	eq(example.panels?.default.models?.[0], "claude/opus", "first panelist is a claude model");
	if (!example.panels?.default.models?.some((m) => m.startsWith("openrouter/"))) throw new Error("expected an openrouter panelist");
	eq(example.panels?.default.judge, "claude/opus", "judge is a claude model");
	eq(example.timeoutSeconds, 600, "example carries the timeout knob");
	const resolved = resolveEffectiveConfig(example);
	if (!resolved.ok) throw new Error(resolved.error.message);
	eq(resolved.profileName, "default", "generated config resolves through named-panel path");
});
```

6. Append:

```ts
test("loadConfigWithPath prefers the project file and reports the path", () => {
	const project = mkdtempSync(join(tmpdir(), "claude-fusion-config-"));
	try {
		eq(loadConfigWithPath(project).path, undefined, "no file means no path");
		mkdirSync(join(project, ".claude"));
		writeFileSync(join(project, ".claude", "fusion.json"), JSON.stringify({ panel: ["claude/opus"] }));
		const loaded = loadConfigWithPath(project);
		eq(loaded.config.panel, ["claude/opus"], "project config loaded");
		eq(loaded.path, join(project, ".claude", "fusion.json"), "project path reported");
		eq(configPaths(project)[0], join(project, ".claude", "fusion.json"), "project path first");
		if (!configPaths(project)[1].endsWith(join(".claude", "fusion.json"))) throw new Error("global path should end with .claude/fusion.json");
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});
```

7. Update the import block at the top to:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyDefaults,
	configPaths,
	generateConfigExample,
	loadConfigWithPath,
	parseFusionConfig,
	resolveEffectiveConfig,
	THINKING_LEVELS,
} from "../config.ts";
import type { FusionConfig } from "../types.ts";
import { eq, test } from "./_harness.ts";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node src/__tests__/config.test.ts`
Expected: module not found for `../config.ts`.

- [ ] **Step 3: Write src/config.ts**

Copy `/home/dev/code/active/pi-fusion/src/config.ts` and apply:

1. Replace the imports with:

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ConfigSelectionError,
	EffectiveConfigResult,
	FusionConfig,
	NamedPanelConfig,
	ResolvedFusionConfig,
	ThinkingLevel,
} from "./types.ts";
```

2. Delete `export const TOOL_OUTPUT_MAX_BYTES = 12_000;` and its comment. Add `export const DEFAULT_TIMEOUT_SECONDS = 600;` after `MAX_TOOL_CALLS`.
3. Delete the `FusionConfigOverrides` interface.
4. Replace `loadConfig` with:

```ts
export function configPaths(projectDir: string): string[] {
	return [join(projectDir, ".claude", "fusion.json"), join(homedir(), ".claude", "fusion.json")];
}

export function loadConfigWithPath(projectDir: string): { config: FusionConfig; path?: string } {
	for (const path of configPaths(projectDir)) {
		if (!existsSync(path)) continue;
		try {
			return { config: parseFusionConfig(readFileSync(path, "utf8")), path };
		} catch (err) {
			console.error(`[claude-fusion] failed to parse ${path}:`, err);
		}
	}
	return { config: {} };
}

export function loadConfig(projectDir: string): FusionConfig {
	return loadConfigWithPath(projectDir).config;
}
```

5. Replace `applyDefaults` with:

```ts
export function applyDefaults(config: FusionConfig): ResolvedFusionConfig {
	return {
		...config,
		maxPanelModels: config.maxPanelModels ?? DEFAULT_MAX_PANEL_MODELS,
		maxPanelOutputTokens: config.maxPanelOutputTokens ?? DEFAULT_MAX_PANEL_OUTPUT_TOKENS,
		maxCompletionTokens: config.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
		temperature: config.temperature ?? DEFAULT_TEMPERATURE,
		maxToolCalls: config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
		timeoutSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
	};
}
```

6. `resolveEffectiveConfig` signature becomes `(config: FusionConfig, explicitPanel?: string): EffectiveConfigResult`; the three `applyDefaults(X, overrides)` calls inside become `applyDefaults(X)`. Its doc comment stays.
7. Replace `generateConfigExample` with:

```ts
export function generateConfigExample(): FusionConfig {
	return {
		defaultPanel: "default",
		panels: {
			default: {
				models: ["claude/opus", "openrouter/openai/gpt-5.5", "openrouter/google/gemini-3-pro"],
				judge: "claude/opus",
				panelReasoning: "medium",
				judgeReasoning: "high",
			},
		},
		maxPanelModels: DEFAULT_MAX_PANEL_MODELS,
		maxPanelOutputTokens: DEFAULT_MAX_PANEL_OUTPUT_TOKENS,
		maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS,
		temperature: DEFAULT_TEMPERATURE,
		panelTools: "none",
		maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
		timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	};
}
```

8. Check the two OpenRouter ids exist: `curl -s https://openrouter.ai/api/v1/models | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const ids=JSON.parse(d).data.map(m=>m.id);for(const id of ["openai/gpt-5.5","google/gemini-3-pro"])console.log(id, ids.includes(id))})'`. If either prints `false`, substitute the closest current id from the same vendor (search the list with `rg`) in both `generateConfigExample` and the config test's expectation.

- [ ] **Step 4: Run check and tests**

Run: `npm run check && node src/__tests__/config.test.ts`
Expected: all `✓`.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "Add fusion.json loading with Claude Code paths"
```

---

### Task 4: Model id parsing, backend interface and tool names

**Files:**
- Create: `src/backends/types.ts`, `src/backends/registry.ts`, `src/tools.ts`
- Test: `src/__tests__/registry.test.ts`, `src/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: `ModelRef`, `BackendName`, `ThinkingLevel`, `PanelToolUsage`, `ToolSelection` from `types.ts`; `DEFAULT_MAX_TOOL_CALLS`, `MIN_TOOL_CALLS`, `MAX_TOOL_CALLS` from `config.ts`
- Produces: `parseModelRef(id): ModelRef | undefined`, `modelDisplay(ref): string`, `sameRef(a, b): boolean`; `ToolName`, `READONLY_TOOL_NAMES`, `MUTATING_TOOL_NAMES`, `ALL_TOOL_NAMES`, `selectionToNames(selection): ToolName[]`, `isMutatingSelection(selection)`, `selectionLabel(selection)`, `clampMaxToolCalls(value)`; `CallOptions`, `CallResult`, `ReasoningSupport`, `Backend`, `Backends`

**Depends on:** Task 3

- [ ] **Step 1: Write src/backends/types.ts**

```ts
import type { ToolName } from "../tools.ts";
import type { BackendName, ModelRef, PanelToolUsage, ThinkingLevel } from "../types.ts";

export interface CallOptions {
	systemPrompt: string;
	userText: string;
	maxTokens: number;
	temperature: number;
	reasoning?: ThinkingLevel;
	tools: ToolName[];
	maxToolCalls: number;
	jsonSchema?: Record<string, unknown>;
	cwd: string;
	signal?: AbortSignal;
}

export interface CallResult {
	text: string;
	structured?: unknown;
	tools?: PanelToolUsage;
	warnings?: string[];
}

export interface ReasoningSupport {
	effective?: ThinkingLevel;
	warning?: string;
}

export interface Backend {
	name: BackendName;
	supportsTools: boolean;
	call(ref: ModelRef, options: CallOptions): Promise<CallResult>;
	contextWindow(ref: ModelRef): Promise<number>;
	supportsReasoning(ref: ModelRef, level: ThinkingLevel): ReasoningSupport;
}

export type Backends = Record<BackendName, Backend>;
```

- [ ] **Step 2: Write the failing registry and tools tests**

`src/__tests__/registry.test.ts`:

```ts
import { modelDisplay, parseModelRef, sameRef } from "../backends/registry.ts";
import { eq, test } from "./_harness.ts";

test("parseModelRef splits backend from model and keeps nested slashes", () => {
	eq(parseModelRef("claude/opus"), { backend: "claude", model: "opus", display: "claude/opus" }, "claude alias");
	eq(
		parseModelRef(" openrouter/openai/gpt-5.5 "),
		{ backend: "openrouter", model: "openai/gpt-5.5", display: "openrouter/openai/gpt-5.5" },
		"openrouter vendor/model, trimmed",
	);
});

test("parseModelRef rejects unknown backends and empty parts", () => {
	for (const bad of ["anthropic/claude-opus-4-5", "claude/", "/opus", "opus", "", "CLAUDE/opus"]) {
		eq(parseModelRef(bad), undefined, `rejects ${JSON.stringify(bad)}`);
	}
});

test("modelDisplay and sameRef use the canonical display string", () => {
	const a = parseModelRef("claude/opus")!;
	const b = parseModelRef("claude/opus ")!;
	eq(modelDisplay(a), "claude/opus", "display");
	eq(sameRef(a, b), true, "same after trim");
	eq(sameRef(a, parseModelRef("claude/sonnet")!), false, "different model");
});
```

`src/__tests__/tools.test.ts`:

```ts
import { clampMaxToolCalls, isMutatingSelection, selectionLabel, selectionToNames } from "../tools.ts";
import { eq, test } from "./_harness.ts";

test("selectionToNames maps modes to Claude Code tool names", () => {
	eq(selectionToNames(undefined), [], "undefined");
	eq(selectionToNames("none"), [], "none");
	eq(selectionToNames("readonly"), ["Read", "Grep", "Glob"], "readonly");
	eq(selectionToNames("all"), ["Read", "Grep", "Glob", "Bash", "Edit", "Write"], "all");
});

test("selectionToNames accepts pi-fusion aliases, dedupes and drops unknown names", () => {
	eq(selectionToNames(["read", "find", "ls", "GLOB", "bash", "fusion", "Read"]), ["Read", "Glob", "Bash"], "aliases and dedupe");
});

test("isMutatingSelection and selectionLabel", () => {
	eq(isMutatingSelection("readonly"), false, "readonly is not mutating");
	eq(isMutatingSelection(["read", "edit"]), true, "edit is mutating");
	eq(selectionLabel(undefined), "none", "label none");
	eq(selectionLabel("all"), "all", "label all");
	eq(selectionLabel(["find", "read"]), "Glob,Read", "label list");
	eq(selectionLabel(["nope"]), "none", "label empty list");
});

test("clampMaxToolCalls bounds and defaults", () => {
	eq(clampMaxToolCalls(undefined), 16, "default");
	eq(clampMaxToolCalls(0), 1, "min");
	eq(clampMaxToolCalls(500), 100, "max");
	eq(clampMaxToolCalls(7.9), 7, "floor");
	eq(clampMaxToolCalls(Number.NaN), 16, "nan");
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node src/__tests__/registry.test.ts; node src/__tests__/tools.test.ts`
Expected: module not found errors.

- [ ] **Step 4: Write src/backends/registry.ts**

```ts
import type { BackendName, ModelRef } from "../types.ts";

const BACKEND_NAMES: readonly BackendName[] = ["claude", "openrouter"];

function isBackendName(value: string): value is BackendName {
	return (BACKEND_NAMES as readonly string[]).includes(value);
}

export function parseModelRef(id: string): ModelRef | undefined {
	const trimmed = id.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return undefined;
	const backend = trimmed.slice(0, slash);
	const model = trimmed.slice(slash + 1);
	if (!isBackendName(backend) || model.length === 0) return undefined;
	return { backend, model, display: `${backend}/${model}` };
}

export function modelDisplay(ref: ModelRef): string {
	return ref.display;
}

export function sameRef(a: ModelRef, b: ModelRef): boolean {
	return a.display === b.display;
}
```

- [ ] **Step 5: Write src/tools.ts**

```ts
import { DEFAULT_MAX_TOOL_CALLS, MAX_TOOL_CALLS, MIN_TOOL_CALLS } from "./config.ts";
import type { ToolSelection } from "./types.ts";

export type ToolName = "Read" | "Grep" | "Glob" | "Bash" | "Edit" | "Write";

export const READONLY_TOOL_NAMES: readonly ToolName[] = ["Read", "Grep", "Glob"];
export const MUTATING_TOOL_NAMES: readonly ToolName[] = ["Bash", "Edit", "Write"];
export const ALL_TOOL_NAMES: readonly ToolName[] = [...READONLY_TOOL_NAMES, ...MUTATING_TOOL_NAMES];

const ALIASES: Record<string, ToolName> = {
	read: "Read",
	grep: "Grep",
	glob: "Glob",
	find: "Glob",
	ls: "Glob",
	bash: "Bash",
	edit: "Edit",
	write: "Write",
};

export function selectionToNames(selection: ToolSelection | undefined): ToolName[] {
	if (!selection || selection === "none") return [];
	if (selection === "readonly") return [...READONLY_TOOL_NAMES];
	if (selection === "all") return [...ALL_TOOL_NAMES];
	if (Array.isArray(selection)) {
		const out: ToolName[] = [];
		for (const raw of selection) {
			const name = ALIASES[String(raw).toLowerCase()];
			if (name && !out.includes(name)) out.push(name);
		}
		return out;
	}
	return [];
}

export function isMutatingSelection(selection: ToolSelection | undefined): boolean {
	return selectionToNames(selection).some((n) => MUTATING_TOOL_NAMES.includes(n));
}

export function selectionLabel(selection: ToolSelection | undefined): string {
	if (!selection || selection === "none") return "none";
	if (selection === "readonly" || selection === "all") return selection;
	const names = selectionToNames(selection);
	return names.length ? names.join(",") : "none";
}

export function clampMaxToolCalls(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_TOOL_CALLS;
	return Math.max(MIN_TOOL_CALLS, Math.min(MAX_TOOL_CALLS, Math.floor(value)));
}
```

- [ ] **Step 6: Run check and tests**

Run: `npm run check && node src/__tests__/registry.test.ts && node src/__tests__/tools.test.ts`
Expected: all `✓`.

- [ ] **Step 7: Commit**

```bash
git add src/backends src/tools.ts src/__tests__/registry.test.ts src/__tests__/tools.test.ts
git commit -m "Add backend interface, model id parsing and tool names"
```

---

### Task 5: Panel and judge resolution

**Files:**
- Create: `src/models.ts`
- Test: `src/__tests__/models.test.ts`

**Interfaces:**
- Consumes: `parseModelRef`, `modelDisplay`, `sameRef` (Task 4); `MAX_PANEL_MODELS_HARD_LIMIT` (Task 3); `ModelRef`
- Produces: `ResolveSource = "explicit" | "default" | "legacy"`, `ResolveCandidate { source; panel: string[]; judge?; maxPanelModels; profileName?; strict? }`, `ResolveResult { panel: ModelRef[]; judge: ModelRef; warnings: string[]; source; profileName? }`, `class PanelSelectionError extends Error { profileName: string | undefined; warnings: string[] }`, `NO_PANEL_MESSAGE`, `resolvePanelAndJudge({ candidates, warnings? }): ResolveResult` (synchronous, throws `PanelSelectionError`)

**Depends on:** Task 4

- [ ] **Step 1: Write the failing test**

`src/__tests__/models.test.ts`:

```ts
import { NO_PANEL_MESSAGE, PanelSelectionError, resolvePanelAndJudge } from "../models.ts";
import { modelDisplay } from "../backends/registry.ts";
import { eq, test } from "./_harness.ts";

function attempt(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

test("first candidate with valid ids wins, capped at maxPanelModels, deduped", () => {
	const result = resolvePanelAndJudge({
		candidates: [
			{ source: "default", profileName: "quality", panel: ["claude/opus", "claude/opus", "openrouter/a/b", "openrouter/c/d"], judge: "claude/sonnet", maxPanelModels: 2 },
			{ source: "legacy", panel: ["claude/haiku"], maxPanelModels: 3 },
		],
	});
	eq(result.panel.map(modelDisplay), ["claude/opus", "openrouter/a/b"], "deduped and capped");
	eq(modelDisplay(result.judge), "claude/sonnet", "judge resolved");
	eq(result.source, "default", "source");
	eq(result.profileName, "quality", "profile name");
	eq(result.warnings, [], "no warnings");
});

test("hard limit of 8 applies even when a candidate asks for more", () => {
	const panel = Array.from({ length: 10 }, (_, i) => `openrouter/v/m${i}`);
	const result = resolvePanelAndJudge({ candidates: [{ source: "legacy", panel, maxPanelModels: 20 }] });
	eq(result.panel.length, 8, "hard cap");
});

test("invalid ids warn and a candidate with none falls through to the next", () => {
	const result = resolvePanelAndJudge({
		warnings: ["earlier"],
		candidates: [
			{ source: "default", profileName: "quality", panel: ["anthropic/opus"], maxPanelModels: 3 },
			{ source: "legacy", panel: ["claude/opus"], maxPanelModels: 3 },
		],
	});
	eq(result.panel.map(modelDisplay), ["claude/opus"], "legacy wins");
	eq(result.source, "legacy", "legacy source");
	eq(result.profileName, undefined, "failed default not reported");
	eq(result.warnings, [
		"earlier",
		"Unknown model identifier: anthropic/opus",
		'Named panel "quality" contained no valid model identifiers. Trying the next configured candidate.',
	], "warning order");
});

test("strict candidate throws without consulting later candidates", () => {
	const error = attempt(() =>
		resolvePanelAndJudge({
			candidates: [
				{ source: "explicit", profileName: "quality", panel: ["bogus"], maxPanelModels: 3, strict: true },
				{ source: "legacy", panel: ["claude/opus"], maxPanelModels: 3 },
			],
		}),
	);
	if (!(error instanceof PanelSelectionError)) throw new Error("expected PanelSelectionError");
	eq(error.profileName, "quality", "names the panel");
	eq(error.message, 'Named panel "quality" contained no valid model identifiers.', "message");
	eq(error.warnings.length, 2, "carries warnings");
});

test("no candidates at all is a PanelSelectionError with the no-panel message", () => {
	const error = attempt(() => resolvePanelAndJudge({ candidates: [{ source: "legacy", panel: [], maxPanelModels: 3 }] }));
	if (!(error instanceof PanelSelectionError)) throw new Error("expected PanelSelectionError");
	eq(error.profileName, undefined, "no profile");
	eq(error.message, NO_PANEL_MESSAGE, "no-panel message");
});

test("missing or invalid judge falls back to the first panelist with a warning", () => {
	const noJudge = resolvePanelAndJudge({ candidates: [{ source: "legacy", panel: ["openrouter/a/b", "claude/opus"], maxPanelModels: 3 }] });
	eq(modelDisplay(noJudge.judge), "openrouter/a/b", "first panelist judges");
	eq(noJudge.warnings, [], "no warning when judge simply unset");

	const badJudge = resolvePanelAndJudge({ candidates: [{ source: "legacy", panel: ["claude/opus"], judge: "nope", maxPanelModels: 3 }] });
	eq(modelDisplay(badJudge.judge), "claude/opus", "fallback judge");
	eq(badJudge.warnings, ["Unknown judge identifier: nope"], "judge warning");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node src/__tests__/models.test.ts`
Expected: module not found for `../models.ts`.

- [ ] **Step 3: Write src/models.ts**

```ts
import { parseModelRef, sameRef } from "./backends/registry.ts";
import { MAX_PANEL_MODELS_HARD_LIMIT } from "./config.ts";
import type { ModelRef } from "./types.ts";

export type ResolveSource = "explicit" | "default" | "legacy";

export interface ResolveCandidate {
	source: ResolveSource;
	panel: string[];
	judge?: string;
	maxPanelModels: number;
	profileName?: string;
	/** Fail closed when the candidate resolves to no models. */
	strict?: boolean;
}

export interface ResolveResult {
	panel: ModelRef[];
	judge: ModelRef;
	warnings: string[];
	source: ResolveSource;
	profileName?: string;
}

export interface ResolveOptions {
	candidates: ResolveCandidate[];
	warnings?: string[];
}

export const NO_PANEL_MESSAGE = "No panel configured. Run /fusion-init to create .claude/fusion.json.";

export class PanelSelectionError extends Error {
	readonly profileName: string | undefined;
	readonly warnings: string[];

	constructor(profileName: string | undefined, warnings: string[], message: string) {
		super(message);
		this.name = "PanelSelectionError";
		this.profileName = profileName;
		this.warnings = warnings;
	}
}

function resolvePanelIdentifiers(identifiers: string[], maxPanel: number, warnings: string[]): ModelRef[] {
	const panel: ModelRef[] = [];
	for (const id of identifiers) {
		const ref = parseModelRef(id);
		if (!ref) {
			warnings.push(`Unknown model identifier: ${id}`);
			continue;
		}
		if (!panel.some((m) => sameRef(m, ref))) panel.push(ref);
		if (panel.length >= maxPanel) break;
	}
	return panel;
}

export function resolvePanelAndJudge(options: ResolveOptions): ResolveResult {
	const warnings = [...(options.warnings ?? [])];
	let panel: ModelRef[] = [];
	let selected: ResolveCandidate | undefined;

	for (const candidate of options.candidates) {
		if (candidate.panel.length === 0) continue;
		const maxPanel = Math.min(candidate.maxPanelModels, MAX_PANEL_MODELS_HARD_LIMIT);
		panel = resolvePanelIdentifiers(candidate.panel, maxPanel, warnings);
		if (panel.length > 0) {
			selected = candidate;
			break;
		}
		const label = candidate.profileName ? `Named panel "${candidate.profileName}"` : "Legacy panel";
		const message = `${label} contained no valid model identifiers.`;
		warnings.push(candidate.strict ? message : `${message} Trying the next configured candidate.`);
		if (candidate.strict) throw new PanelSelectionError(candidate.profileName, warnings, message);
	}

	if (!selected) throw new PanelSelectionError(undefined, warnings, NO_PANEL_MESSAGE);

	let judge: ModelRef | undefined;
	if (selected.judge) {
		judge = parseModelRef(selected.judge);
		if (!judge) warnings.push(`Unknown judge identifier: ${selected.judge}`);
	}
	if (!judge) judge = panel[0];

	return {
		panel,
		judge,
		warnings,
		source: selected.source,
		...(selected.profileName ? { profileName: selected.profileName } : {}),
	};
}
```

- [ ] **Step 4: Run check and tests**

Run: `npm run check && node src/__tests__/models.test.ts`
Expected: all `✓`.

- [ ] **Step 5: Commit**

```bash
git add src/models.ts src/__tests__/models.test.ts
git commit -m "Add panel and judge resolution over model ids"
```

---

### Task 6: Claude backend

**Files:**
- Create: `src/backends/claude.ts`
- Test: `src/__tests__/claude.test.ts`

**Interfaces:**
- Consumes: `Backend`, `CallOptions`, `CallResult`, `ReasoningSupport` (Task 4); `ModelRef`, `ThinkingLevel`
- Produces: `CLAUDE_CONTEXT_WINDOW = 200_000`, `claudeReasoning(level): ReasoningSupport`, `buildClaudeArgs(ref, options): string[]`, `parseClaudeOutput(stdout, stderr, exitCode, options: Pick<CallOptions, "tools" | "maxToolCalls">): CallResult`, `createClaudeBackend(spawnImpl?): Backend`

**Depends on:** Task 4

- [ ] **Step 1: Write the failing test**

`src/__tests__/claude.test.ts`:

```ts
import { buildClaudeArgs, claudeReasoning, createClaudeBackend, parseClaudeOutput } from "../backends/claude.ts";
import type { CallOptions } from "../backends/types.ts";
import { parseModelRef } from "../backends/registry.ts";
import { eq, test } from "./_harness.ts";

const ref = parseModelRef("claude/opus")!;

function options(overrides: Partial<CallOptions> = {}): CallOptions {
	return {
		systemPrompt: "SYS",
		userText: "hello",
		maxTokens: 2048,
		temperature: 0.3,
		tools: [],
		maxToolCalls: 16,
		cwd: "/tmp",
		...overrides,
	};
}

function attempt(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

test("buildClaudeArgs always passes the trimmed context flags", () => {
	const args = buildClaudeArgs(ref, options());
	eq(args, [
		"-p",
		"--output-format", "json",
		"--no-session-persistence",
		"--model", "opus",
		"--system-prompt", "SYS",
		"--strict-mcp-config",
		"--mcp-config", '{"mcpServers":{}}',
		"--setting-sources", "",
		"--tools", "",
	], "no tools, no reasoning, no schema");
});

test("buildClaudeArgs adds tool, effort and schema flags only when requested", () => {
	const args = buildClaudeArgs(ref, options({ tools: ["Read", "Grep"], maxToolCalls: 5, reasoning: "high", jsonSchema: { type: "object" } }));
	const joined = args.join(" ");
	for (const needle of [
		"--tools Read,Grep",
		"--allowedTools Read,Grep",
		"--permission-prompts none",
		"--max-turns 5",
		"--effort high",
		'--json-schema {"type":"object"}',
	]) {
		if (!joined.includes(needle)) throw new Error(`missing ${needle} in ${joined}`);
	}
});

test("claudeReasoning maps minimal to low with a warning and passes the rest through", () => {
	eq(claudeReasoning("minimal"), { effective: "low", warning: "Reasoning minimal is not supported by claude -p; using low." }, "minimal");
	for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
		eq(claudeReasoning(level), { effective: level }, level);
	}
	const backend = createClaudeBackend();
	eq(backend.supportsReasoning(ref, "minimal").warning, "Reasoning minimal is not supported by claude/opus; using low.", "backend names the model");
	eq(backend.supportsTools, true, "claude backend supports tools");
});

test("parseClaudeOutput returns text, structured output and turn accounting", () => {
	const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "answer", structured_output: { consensus: [] }, num_turns: 3 });
	eq(parseClaudeOutput(stdout, "", 0, { tools: [], maxToolCalls: 16 }), { text: "answer", structured: { consensus: [] } }, "no tools means no tool usage");
	eq(parseClaudeOutput(stdout, "", 0, { tools: ["Read"], maxToolCalls: 3 }), {
		text: "answer",
		structured: { consensus: [] },
		tools: { turns: 3, tool_calls: [], capped: true },
	}, "turns at the cap are reported capped");
	eq(parseClaudeOutput("warning line\n" + stdout, "", 0, { tools: [], maxToolCalls: 16 }).text, "answer", "last line is parsed when stdout has a preamble");
});

test("parseClaudeOutput throws the result text on error results and non-zero exits", () => {
	const errored = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in" });
	const e1 = attempt(() => parseClaudeOutput(errored, "", 0, { tools: [], maxToolCalls: 16 })) as Error;
	eq(e1.message, "Not logged in", "is_error surfaces result");
	const capped = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false, result: "" });
	const e2 = attempt(() => parseClaudeOutput(capped, "stderr text", 1, { tools: [], maxToolCalls: 16 })) as Error;
	eq(e2.message, "stderr text", "falls back to stderr");
	const e3 = attempt(() => parseClaudeOutput("", "", 127, { tools: [], maxToolCalls: 16 })) as Error;
	if (!e3.message.includes("no JSON result")) throw new Error(`unexpected: ${e3.message}`);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node src/__tests__/claude.test.ts`
Expected: module not found for `../backends/claude.ts`.

- [ ] **Step 3: Write src/backends/claude.ts**

```ts
import { spawn } from "node:child_process";
import type { ModelRef, ThinkingLevel } from "../types.ts";
import type { Backend, CallOptions, CallResult, ReasoningSupport } from "./types.ts";

export const CLAUDE_CONTEXT_WINDOW = 200_000;
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

export type SpawnLike = typeof spawn;

export function claudeReasoning(level: ThinkingLevel): ReasoningSupport {
	if (level === "minimal") {
		return { effective: "low", warning: "Reasoning minimal is not supported by claude -p; using low." };
	}
	return { effective: level };
}

export function buildClaudeArgs(ref: ModelRef, options: CallOptions): string[] {
	const tools = options.tools.join(",");
	const args = [
		"-p",
		"--output-format", "json",
		"--no-session-persistence",
		"--model", ref.model,
		"--system-prompt", options.systemPrompt,
		"--strict-mcp-config",
		"--mcp-config", EMPTY_MCP_CONFIG,
		"--setting-sources", "",
		"--tools", tools,
	];
	if (options.tools.length > 0) {
		args.push("--allowedTools", tools, "--permission-prompts", "none", "--max-turns", String(options.maxToolCalls));
	}
	if (options.reasoning) args.push("--effort", options.reasoning);
	if (options.jsonSchema) args.push("--json-schema", JSON.stringify(options.jsonSchema));
	return args;
}

interface ClaudeJsonResult {
	subtype?: string;
	is_error?: boolean;
	result?: string;
	structured_output?: unknown;
	num_turns?: number;
}

function parseJsonResult(stdout: string): ClaudeJsonResult | undefined {
	const candidates = [stdout, ...stdout.trim().split("\n").reverse()];
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (typeof parsed === "object" && parsed !== null) return parsed as ClaudeJsonResult;
		} catch {
			continue;
		}
	}
	return undefined;
}

export function parseClaudeOutput(
	stdout: string,
	stderr: string,
	exitCode: number | null,
	options: Pick<CallOptions, "tools" | "maxToolCalls">,
): CallResult {
	const parsed = parseJsonResult(stdout);
	if (!parsed) {
		throw new Error(`claude -p produced no JSON result (exit ${exitCode ?? "null"}): ${(stderr || stdout).trim().slice(0, 500)}`);
	}
	if (exitCode !== 0 || parsed.is_error || parsed.subtype !== "success") {
		throw new Error(parsed.result?.trim() || stderr.trim() || `claude -p failed (exit ${exitCode ?? "null"}, ${parsed.subtype ?? "unknown"})`);
	}
	const turns = parsed.num_turns ?? 1;
	return {
		text: parsed.result ?? "",
		...(parsed.structured_output !== undefined ? { structured: parsed.structured_output } : {}),
		...(options.tools.length > 0 ? { tools: { turns, tool_calls: [], capped: turns >= options.maxToolCalls } } : {}),
	};
}

function runClaude(spawnImpl: SpawnLike, ref: ModelRef, options: CallOptions): Promise<CallResult> {
	return new Promise((resolve, reject) => {
		const child = spawnImpl("claude", buildClaudeArgs(ref, options), {
			cwd: options.cwd,
			env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxTokens) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		const onAbort = () => child.kill("SIGTERM");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
		child.on("error", (err: NodeJS.ErrnoException) => {
			cleanup();
			reject(err.code === "ENOENT" ? new Error("claude CLI not found on PATH") : err);
		});
		child.on("close", (code) => {
			cleanup();
			if (options.signal?.aborted) {
				reject(new Error("cancelled"));
				return;
			}
			try {
				resolve(parseClaudeOutput(stdout, stderr, code, options));
			} catch (err) {
				reject(err);
			}
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.userText);
	});
}

export function createClaudeBackend(spawnImpl: SpawnLike = spawn): Backend {
	return {
		name: "claude",
		supportsTools: true,
		supportsReasoning(ref, level) {
			const support = claudeReasoning(level);
			return support.warning
				? { effective: support.effective, warning: `Reasoning ${level} is not supported by ${ref.display}; using low.` }
				: support;
		},
		async contextWindow() {
			return CLAUDE_CONTEXT_WINDOW;
		},
		call(ref, options) {
			return runClaude(spawnImpl, ref, options);
		},
	};
}
```

- [ ] **Step 4: Run check and tests**

Run: `npm run check && node src/__tests__/claude.test.ts`
Expected: all `✓`. If `tsc` complains about the `stdio` tuple or `child.stdout` typing, cast the spawn options with `as const` on the tuple; do not loosen `SpawnLike` to `any`.

- [ ] **Step 5: Smoke test the real spawn path on haiku**

Run from the repo root:

```bash
node --input-type=module -e '
import { createClaudeBackend } from "./src/backends/claude.ts";
import { parseModelRef } from "./src/backends/registry.ts";
const r = await createClaudeBackend().call(parseModelRef("claude/haiku"), { systemPrompt: "Reply with one word.", userText: "Say pong.", maxTokens: 64, temperature: 0, tools: [], maxToolCalls: 1, cwd: process.cwd() });
console.log(JSON.stringify(r));
'
```

Expected: `{"text":"pong"}` (or similar single word). Then the same with `jsonSchema: {"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}` added: expected output includes `"structured":{"word":"pong"}`. This is spec verification item 4; if `--json-schema` fails alongside `--system-prompt`, drop `jsonSchema` from `buildClaudeArgs` and rely on `extractJson` (Task 8 already falls back).

- [ ] **Step 6: Commit**

```bash
git add src/backends/claude.ts src/__tests__/claude.test.ts
git commit -m "Add claude -p backend"
```

---

### Task 7: OpenRouter backend

**Files:**
- Create: `src/backends/openrouter.ts`
- Test: `src/__tests__/openrouter.test.ts`

**Interfaces:**
- Consumes: `Backend`, `CallOptions`, `CallResult` (Task 4); `ModelRef`
- Produces: `DEFAULT_CONTEXT_WINDOW = 128_000`, `buildOpenRouterBody(ref, options): Record<string, unknown>`, `parseOpenRouterResponse(json): string`, `openRouterErrorMessage(status, bodyText): string`, `class OpenRouterHttpError extends Error { status }`, `createOpenRouterBackend(fetchImpl?, env?): Backend`

**Depends on:** Task 4

- [ ] **Step 1: Write the failing test**

`src/__tests__/openrouter.test.ts`:

```ts
import { buildOpenRouterBody, createOpenRouterBackend, openRouterErrorMessage, parseOpenRouterResponse } from "../backends/openrouter.ts";
import { parseModelRef } from "../backends/registry.ts";
import type { CallOptions } from "../backends/types.ts";
import { eq, test } from "./_harness.ts";

const ref = parseModelRef("openrouter/openai/gpt-5.5")!;

function options(overrides: Partial<CallOptions> = {}): CallOptions {
	return { systemPrompt: "SYS", userText: "hello", maxTokens: 2048, temperature: 0.3, tools: [], maxToolCalls: 16, cwd: "/tmp", ...overrides };
}

type Recorded = { url: string; body?: Record<string, unknown>; headers: Record<string, string> };

function fakeFetch(responses: Array<{ status: number; body: unknown }>, recorded: Recorded[] = []): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		recorded.push({
			url: String(url),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		const next = responses.shift() ?? { status: 500, body: { error: { message: "no scripted response" } } };
		return new Response(JSON.stringify(next.body), { status: next.status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

test("buildOpenRouterBody sends system + user messages, temperature and reasoning", () => {
	eq(buildOpenRouterBody(ref, options()), {
		model: "openai/gpt-5.5",
		messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hello" }],
		max_tokens: 2048,
		temperature: 0.3,
	}, "no reasoning");
	eq(buildOpenRouterBody(ref, options({ reasoning: "xhigh" })).reasoning, { effort: "xhigh" }, "reasoning effort");
});

test("parseOpenRouterResponse returns the first choice's content and rejects failures", () => {
	eq(parseOpenRouterResponse({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] }), "answer", "content");
	eq(parseOpenRouterResponse({ choices: [{ message: { content: null } }] }), "", "null content is empty");
	for (const [body, needle] of [
		[{ choices: [] }, "no choices"],
		[{ error: { message: "boom" } }, "boom"],
		[{ choices: [{ finish_reason: "error", message: { content: "" } }] }, "generation error"],
	] as const) {
		let message = "";
		try {
			parseOpenRouterResponse(body);
		} catch (err) {
			message = (err as Error).message;
		}
		if (!message.includes(needle)) throw new Error(`expected ${needle}, got ${message}`);
	}
});

test("openRouterErrorMessage keeps status, credit and rate-limit wording for classification", () => {
	eq(openRouterErrorMessage(402, JSON.stringify({ error: { message: "Insufficient credits" } })), "OpenRouter 402 (insufficient credits): Insufficient credits", "402");
	eq(openRouterErrorMessage(429, "slow down"), "OpenRouter 429 (rate limited): slow down", "429 plain text");
	eq(openRouterErrorMessage(500, ""), "OpenRouter 500: ", "500");
});

test("backend call posts with auth headers and returns text", async () => {
	const recorded: Recorded[] = [];
	const backend = createOpenRouterBackend(
		fakeFetch([{ status: 200, body: { choices: [{ message: { content: "answer" } }] } }], recorded),
		{ OPENROUTER_API_KEY: "k" },
	);
	eq(await backend.call(ref, options()), { text: "answer" }, "text result");
	eq(recorded[0].url, "https://openrouter.ai/api/v1/chat/completions", "endpoint");
	eq(recorded[0].headers.Authorization, "Bearer k", "auth header");
	eq(recorded[0].headers["X-OpenRouter-Title"], "claude-fusion", "title header");
	eq(backend.supportsTools, false, "no tools");
	eq(backend.supportsReasoning(ref, "minimal"), { effective: "minimal" }, "all levels pass through");
});

test("backend call fails fast without a key and surfaces HTTP errors", async () => {
	const noKey = createOpenRouterBackend(fakeFetch([]), {});
	let message = "";
	try {
		await noKey.call(ref, options());
	} catch (err) {
		message = (err as Error).message;
	}
	eq(message, "OPENROUTER_API_KEY is not set", "missing key");

	const limited = createOpenRouterBackend(fakeFetch([{ status: 429, body: { error: { message: "rate limit exceeded" } } }]), { OPENROUTER_API_KEY: "k" });
	try {
		await limited.call(ref, options());
		throw new Error("expected failure");
	} catch (err) {
		eq((err as Error).message, "OpenRouter 429 (rate limited): rate limit exceeded", "429 message");
	}
});

test("a 400 with reasoning set retries once without reasoning and warns", async () => {
	const recorded: Recorded[] = [];
	const backend = createOpenRouterBackend(
		fakeFetch([
			{ status: 400, body: { error: { message: "reasoning not supported" } } },
			{ status: 200, body: { choices: [{ message: { content: "plain answer" } }] } },
		], recorded),
		{ OPENROUTER_API_KEY: "k" },
	);
	const result = await backend.call(ref, options({ reasoning: "high" }));
	eq(result.text, "plain answer", "retry result");
	eq(result.warnings, ["OpenRouter rejected reasoning high for openrouter/openai/gpt-5.5; retried without reasoning."], "warning");
	eq(recorded.length, 2, "two requests");
	eq(recorded[1].body?.reasoning, undefined, "retry drops reasoning");
});

test("contextWindow reads the models list once and falls back to the default", async () => {
	const recorded: Recorded[] = [];
	const backend = createOpenRouterBackend(
		fakeFetch([{ status: 200, body: { data: [{ id: "openai/gpt-5.5", context_length: 400000 }] } }], recorded),
		{ OPENROUTER_API_KEY: "k" },
	);
	eq(await backend.contextWindow(ref), 400000, "listed model");
	eq(await backend.contextWindow(parseModelRef("openrouter/x/unlisted")!), 128000, "fallback");
	eq(recorded.length, 1, "models fetched once");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node src/__tests__/openrouter.test.ts`
Expected: module not found.

- [ ] **Step 3: Write src/backends/openrouter.ts**

```ts
import type { ModelRef } from "../types.ts";
import type { Backend, CallOptions, CallResult } from "./types.ts";

const BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface OpenRouterEnv {
	OPENROUTER_API_KEY?: string;
}

export function buildOpenRouterBody(ref: ModelRef, options: CallOptions): Record<string, unknown> {
	return {
		model: ref.model,
		messages: [
			{ role: "system", content: options.systemPrompt },
			{ role: "user", content: options.userText },
		],
		max_tokens: options.maxTokens,
		temperature: options.temperature,
		...(options.reasoning ? { reasoning: { effort: options.reasoning } } : {}),
	};
}

interface ChatResponse {
	choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
	error?: { message?: string };
}

export function parseOpenRouterResponse(json: unknown): string {
	const body = (json ?? {}) as ChatResponse;
	if (body.error?.message) throw new Error(`OpenRouter error: ${body.error.message}`);
	const choice = body.choices?.[0];
	if (!choice) throw new Error("OpenRouter returned no choices");
	if (choice.finish_reason === "error") throw new Error("OpenRouter reported a generation error");
	return choice.message?.content ?? "";
}

export function openRouterErrorMessage(status: number, bodyText: string): string {
	let message = bodyText.trim();
	try {
		const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
		if (parsed.error?.message) message = parsed.error.message;
	} catch {
		// plain text body
	}
	const suffix = status === 402 ? " (insufficient credits)" : status === 429 ? " (rate limited)" : "";
	return `OpenRouter ${status}${suffix}: ${message.slice(0, 500)}`;
}

export class OpenRouterHttpError extends Error {
	readonly status: number;

	constructor(status: number, bodyText: string) {
		super(openRouterErrorMessage(status, bodyText));
		this.name = "OpenRouterHttpError";
		this.status = status;
	}
}

export function createOpenRouterBackend(fetchImpl: typeof fetch = fetch, env: OpenRouterEnv = process.env): Backend {
	let modelsCache: Promise<Map<string, number>> | undefined;

	function headers(): Record<string, string> {
		const key = env.OPENROUTER_API_KEY;
		if (!key) throw new Error("OPENROUTER_API_KEY is not set");
		return {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://github.com/callumw-k/claude-fusion",
			"X-OpenRouter-Title": "claude-fusion",
		};
	}

	async function post(body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<string> {
		const res = await fetchImpl(`${BASE_URL}/chat/completions`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) throw new OpenRouterHttpError(res.status, await res.text());
		return parseOpenRouterResponse(await res.json());
	}

	async function loadModels(): Promise<Map<string, number>> {
		try {
			const res = await fetchImpl(`${BASE_URL}/models`, { headers: headers() });
			if (!res.ok) return new Map();
			const json = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> };
			return new Map(
				(json.data ?? [])
					.filter((m) => typeof m.context_length === "number")
					.map((m) => [m.id, m.context_length as number]),
			);
		} catch {
			return new Map();
		}
	}

	return {
		name: "openrouter",
		supportsTools: false,
		supportsReasoning(_ref, level) {
			return { effective: level };
		},
		async contextWindow(ref) {
			modelsCache ??= loadModels();
			return (await modelsCache).get(ref.model) ?? DEFAULT_CONTEXT_WINDOW;
		},
		async call(ref, options): Promise<CallResult> {
			const body = buildOpenRouterBody(ref, options);
			try {
				return { text: await post(body, options.signal) };
			} catch (err) {
				if (err instanceof OpenRouterHttpError && err.status === 400 && options.reasoning) {
					const { reasoning: _rejected, ...withoutReasoning } = body;
					const text = await post(withoutReasoning, options.signal);
					return {
						text,
						warnings: [`OpenRouter rejected reasoning ${options.reasoning} for ${ref.display}; retried without reasoning.`],
					};
				}
				throw err;
			}
		},
	};
}
```

- [ ] **Step 4: Run check and tests**

Run: `npm run check && node src/__tests__/openrouter.test.ts`
Expected: all `✓`. `check:strict` will flag `_rejected` as unused; if it does, replace the destructure with `const withoutReasoning = { ...body }; delete withoutReasoning.reasoning;`.

- [ ] **Step 5: Spec verification item 5 (reasoning on a non-reasoning model)**

Only if `OPENROUTER_API_KEY` is set in the shell. Run:

```bash
curl -s https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" -d '{"model":"openai/gpt-4.1-mini","messages":[{"role":"user","content":"pong"}],"max_tokens":5,"reasoning":{"effort":"high"}}' | head -c 400
```

Record in the commit body whether it returned 200 (field ignored) or 400. If 200, the retry branch is dead but harmless; leave it. If the key is not set, skip and note it in the task report.

- [ ] **Step 6: Commit**

```bash
git add src/backends/openrouter.ts src/__tests__/openrouter.test.ts
git commit -m "Add OpenRouter backend"
```

---

### Task 8: Fusion pipeline

**Files:**
- Create: `src/fusion.ts`, `src/__tests__/_fake_backend.ts`
- Test: `src/__tests__/fusion.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveConfig`, `PANEL_CONCURRENCY`, `ResolvedFusionConfig` (Task 3); `modelDisplay` (Task 4); `Backend`, `Backends`, `CallOptions`, `CallResult` (Task 4); `PanelSelectionError`, `resolvePanelAndJudge`, `ResolveCandidate`, `ResolveResult` (Task 5); prompts and schema (Task 2); tools helpers (Task 4); `extractJson`, `mapWithConcurrencyLimit`, `truncateToBytes` (Task 1)
- Produces: `parseFusionAnalysis(value)`, `compactFusionToolText(details)`, `emptyPanelError(content, capped)`, `resolvePanelReasoning(panel, backends, requested?)`, `resolveFusionSelection(rawConfig, overrides): FusionSelectionResult` (sync), `RunFusionInput`, `runFusion(input): Promise<FusionResult>`; test helper `fakeBackend(name, responses, opts?)`

**Depends on:** Task 5

- [ ] **Step 1: Write the fake backend**

`src/__tests__/_fake_backend.ts`:

```ts
import type { Backend, Backends, CallOptions, CallResult, ReasoningSupport } from "../backends/types.ts";
import type { BackendName, ModelRef, ThinkingLevel } from "../types.ts";

export type ScriptedResponse = CallResult | Error | ((options: CallOptions) => CallResult);

export interface RecordedCall {
	model: string;
	options: CallOptions;
}

export interface FakeBackend extends Backend {
	calls: RecordedCall[];
}

export function fakeBackend(
	name: BackendName,
	responses: Record<string, ScriptedResponse>,
	opts: { supportsTools?: boolean; reasoning?: (ref: ModelRef, level: ThinkingLevel) => ReasoningSupport; contextWindow?: number } = {},
): FakeBackend {
	const calls: RecordedCall[] = [];
	return {
		name,
		calls,
		supportsTools: opts.supportsTools ?? false,
		supportsReasoning: opts.reasoning ?? ((_ref, level) => ({ effective: level })),
		async contextWindow() {
			return opts.contextWindow ?? 128_000;
		},
		async call(ref, options) {
			calls.push({ model: ref.model, options });
			const scripted = responses[ref.model];
			if (scripted === undefined) throw new Error(`no response scripted for ${ref.display}`);
			if (scripted instanceof Error) throw scripted;
			return typeof scripted === "function" ? scripted(options) : scripted;
		},
	};
}

export function fakeBackends(claude: FakeBackend, openrouter: FakeBackend): Backends {
	return { claude, openrouter };
}

export const EMPTY_ANALYSIS = JSON.stringify({ consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] });
```

- [ ] **Step 2: Write the failing fusion test**

`src/__tests__/fusion.test.ts`:

```ts
import {
	compactFusionToolText,
	emptyPanelError,
	parseFusionAnalysis,
	resolveFusionSelection,
	resolvePanelReasoning,
	runFusion,
	type RunFusionInput,
} from "../fusion.ts";
import { parseModelRef } from "../backends/registry.ts";
import type { FusionConfig } from "../types.ts";
import { EMPTY_ANALYSIS, fakeBackend, fakeBackends } from "./_fake_backend.ts";
import { eq, test } from "./_harness.ts";

test("parseFusionAnalysis defaults missing arrays to empty", () => {
	eq(parseFusionAnalysis({ consensus: ["agreed"] }), {
		consensus: ["agreed"],
		contradictions: [],
		partial_coverage: [],
		unique_insights: [],
		blind_spots: [],
	}, "missing arrays default to []");
	eq(parseFusionAnalysis("not an object"), undefined, "non-object");
	eq(parseFusionAnalysis(undefined), undefined, "undefined");
	eq(parseFusionAnalysis({}), undefined, "empty object");
	eq(parseFusionAnalysis({ consensus: "string" }), undefined, "non-array key");
});

test("compactFusionToolText returns analysis plus excerpts, not full panel text", () => {
	const long = "PANEL-FULL-".repeat(80);
	const text = compactFusionToolText({
		status: "ok",
		analysis: { consensus: ["agreed"], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] },
		responses: [{ model: "claude/opus", content: long }],
		panel_models: ["claude/opus"],
		judge_model: "claude/sonnet",
	});
	if (!text.includes("agreed")) throw new Error("expected analysis");
	if (!text.includes("excerpts")) throw new Error("expected excerpts key");
	if (text.includes(long)) throw new Error("must not include full panel answer");
	if (!text.includes("…")) throw new Error("expected truncated excerpt");
});

test("compactFusionToolText passes through a lone unjudged panel response", () => {
	const long = "PANEL-FULL-".repeat(80);
	const text = compactFusionToolText({ status: "ok", responses: [{ model: "claude/opus", content: long }], panel_models: ["claude/opus"], judge_model: "claude/sonnet" });
	if (!text.includes(long)) throw new Error("single unjudged response must be returned in full");
});

test("emptyPanelError classifies blank output", () => {
	eq(emptyPanelError("a real answer", true), undefined, "non-empty");
	eq(emptyPanelError("   \n\t ", false), "empty response", "whitespace");
	eq(emptyPanelError("", true), "no text answer (tool-call budget or loop guard hit)", "capped + empty");
});

const twoBackendConfig: FusionConfig = {
	panels: { quality: { models: ["claude/opus", "openrouter/openai/gpt-5.5"], judge: "claude/sonnet", panelReasoning: "xhigh" } },
	defaultPanel: "quality",
	panelReasoning: "low",
	judgeReasoning: "medium",
};

test("resolveFusionSelection reports the named default and explicit profiles", () => {
	const byDefault = resolveFusionSelection(twoBackendConfig, {});
	if (!byDefault.ok) throw new Error(byDefault.result.details.error);
	eq(byDefault.resolution.profileName, "quality", "default profile");
	eq(byDefault.resolution.source, "default", "default source");
	eq(byDefault.config.panelReasoning, "xhigh", "named panel reasoning wins");
	eq(byDefault.config.judgeReasoning, "medium", "judge reasoning inherited");

	const explicit = resolveFusionSelection({ ...twoBackendConfig, defaultPanel: undefined }, { panel_profile: "quality" });
	if (!explicit.ok) throw new Error(explicit.result.details.error);
	eq(explicit.resolution.source, "explicit", "explicit source");
});

test("resolveFusionSelection fails closed for a bad explicit profile and for no panel at all", () => {
	const missing = resolveFusionSelection(twoBackendConfig, { panel_profile: "nope" });
	if (missing.ok) throw new Error("expected failure");
	eq(missing.result.details.status, "error", "error status");
	eq(missing.result.details.panel_profile, "nope", "names the panel");
	eq(missing.result.details.responses, [], "no responses");

	const empty = resolveFusionSelection({}, {});
	if (empty.ok) throw new Error("expected failure");
	if (!empty.result.details.error?.includes("No panel configured")) throw new Error(`unexpected: ${empty.result.details.error}`);
});

test("resolveFusionSelection falls back from an unresolvable default to the legacy panel with warnings", () => {
	const result = resolveFusionSelection({
		panel: ["claude/opus"],
		judge: "claude/sonnet",
		panels: { quality: { models: ["anthropic/opus"] } },
		defaultPanel: "quality",
	}, {});
	if (!result.ok) throw new Error(result.result.details.error);
	eq(result.resolution.panel.map((m) => m.display), ["claude/opus"], "legacy panel");
	eq(result.resolution.profileName, undefined, "failed default not reported");
	if (!result.resolution.warnings.some((w) => w.includes("quality"))) throw new Error(`missing warning: ${result.resolution.warnings.join("; ")}`);
});

test("resolvePanelReasoning records per-model support in panel order", () => {
	const claude = fakeBackend("claude", {}, { reasoning: (_ref, level) => (level === "minimal" ? { effective: "low", warning: "minimal downgraded" } : { effective: level }) });
	const openrouter = fakeBackend("openrouter", {});
	const plan = resolvePanelReasoning([parseModelRef("claude/opus")!, parseModelRef("openrouter/a/b")!], fakeBackends(claude, openrouter), "minimal");
	eq(plan.effective, { "claude/opus": "low", "openrouter/a/b": "minimal" }, "effective per model");
	eq(plan.warnings, ["minimal downgraded"], "warning collected");
	eq(resolvePanelReasoning([parseModelRef("claude/opus")!], fakeBackends(claude, openrouter), undefined).effective, { "claude/opus": null }, "no request means null");
});

function input(config: FusionConfig, backends: RunFusionInput["backends"], overrides: Partial<RunFusionInput> = {}): RunFusionInput {
	return { projectDir: "/tmp", config, backends, prompt: "compare", overrides: {}, consented: false, ...overrides };
}

test("runFusion runs the panel, prefers structured judge output and records reasoning diagnostics", async () => {
	const claude = fakeBackend("claude", {
		opus: { text: "claude answer that is long enough to be excerpted by the tool result text" },
		sonnet: { text: "ignored text", structured: { consensus: ["both agree"] } },
	}, { supportsTools: true });
	const openrouter = fakeBackend("openrouter", { "openai/gpt-5.5": { text: "openrouter answer that is long enough to be excerpted by the tool result" } });
	const progress: string[] = [];
	const result = await runFusion(input(twoBackendConfig, fakeBackends(claude, openrouter), { onProgress: (m) => progress.push(m) }));

	eq(result.details.status, "ok", "ok");
	eq(result.details.analysis?.consensus, ["both agree"], "structured judge output used");
	eq(result.details.responses.map((r) => r.model), ["claude/opus", "openrouter/openai/gpt-5.5"], "panel order kept");
	eq(result.details.judge_model, "claude/sonnet", "judge");
	eq(result.details.panel_profile, "quality", "profile");
	eq(result.details.panel_reasoning, { requested: "xhigh", effective: { "claude/opus": "xhigh", "openrouter/openai/gpt-5.5": "xhigh" } }, "panel reasoning");
	eq(result.details.judge_reasoning, { requested: "medium", effective: "medium" }, "judge reasoning");
	eq(claude.calls.map((c) => [c.model, c.options.reasoning, c.options.jsonSchema !== undefined]), [["opus", "xhigh", false], ["sonnet", "medium", true]], "claude calls: panel then judge with schema");
	eq(openrouter.calls[0].options.reasoning, "xhigh", "openrouter reasoning");
	if (!openrouter.calls[0].options.signal) throw new Error("expected a timeout signal on every call");
	eq(progress.length, 2, "resolving and judging progress");
	if (!result.content[0].text.includes("excerpts")) throw new Error("tool text uses excerpts");
});

test("runFusion skips the judge with a single success and passes the answer through", async () => {
	const claude = fakeBackend("claude", { opus: { text: "only answer" }, sonnet: new Error("should not be called") });
	const openrouter = fakeBackend("openrouter", { "openai/gpt-5.5": new Error("OpenRouter 429 (rate limited): slow down") });
	const result = await runFusion(input(twoBackendConfig, fakeBackends(claude, openrouter)));
	eq(result.details.status, "ok", "still ok");
	eq(result.details.analysis, undefined, "no analysis");
	eq(result.details.failed_models, [{ model: "openrouter/openai/gpt-5.5", error: "OpenRouter 429 (rate limited): slow down" }], "failure recorded");
	eq(claude.calls.map((c) => c.model), ["opus"], "judge never called");
	if (!result.content[0].text.includes("only answer")) throw new Error("single answer passes through");
});

test("runFusion surfaces an unparseable judge and classifies total failure", async () => {
	const claude = fakeBackend("claude", { opus: { text: "first answer, long enough to be excerpted in the tool result output" }, sonnet: { text: "the judge said words but not JSON" } });
	const openrouter = fakeBackend("openrouter", { "openai/gpt-5.5": { text: "second answer, long enough to be excerpted in the tool result output" } });
	const result = await runFusion(input(twoBackendConfig, fakeBackends(claude, openrouter)));
	eq(result.details.analysis, undefined, "no analysis");
	eq(result.details.failure_reason, "unexpected_error", "judge failure classified");
	if (!result.details.warnings?.some((w) => w.includes("unparseable"))) throw new Error("expected unparseable warning");

	const allFail = await runFusion(input(twoBackendConfig, fakeBackends(
		fakeBackend("claude", { opus: new Error("OpenRouter 402 (insufficient credits): nope") }),
		fakeBackend("openrouter", { "openai/gpt-5.5": new Error("OpenRouter 402 (insufficient credits): nope") }),
	)));
	eq(allFail.details.status, "error", "error status");
	eq(allFail.details.failure_reason, "insufficient_credits", "credits classified");
	eq(allFail.details.error, "all panel models failed", "error text");
});

test("runFusion strips mutating tools without consent, serialises with consent, and warns for toolless backends", async () => {
	const withTools: FusionConfig = { panel: ["claude/opus", "openrouter/a/b"], judge: "claude/sonnet", panelTools: "all", maxToolCalls: 4 };
	const claude = fakeBackend("claude", { opus: { text: "claude", structured: undefined }, sonnet: { text: EMPTY_ANALYSIS } }, { supportsTools: true });
	const openrouter = fakeBackend("openrouter", { "a/b": { text: "openrouter" } });

	const stripped = await runFusion(input(withTools, fakeBackends(claude, openrouter)));
	eq(claude.calls[0].options.tools, ["Read", "Grep", "Glob"], "readonly subset without consent");
	eq(openrouter.calls[0].options.tools, [], "openrouter never gets tools");
	eq(stripped.details.panel_tools, { mode: "Read,Grep,Glob", max_tool_calls: 4, serialized: false }, "diagnostics");
	if (!stripped.details.warnings?.some((w) => w.includes("consent"))) throw new Error("expected consent warning");
	if (!stripped.details.warnings?.some((w) => w.includes("openrouter/a/b runs without panel tools"))) throw new Error("expected toolless warning");

	claude.calls.length = 0;
	const consented = await runFusion(input({ ...withTools, panelToolsConsent: true }, fakeBackends(claude, openrouter)));
	eq(claude.calls[0].options.tools, ["Read", "Grep", "Glob", "Bash", "Edit", "Write"], "all tools with consent");
	eq(consented.details.panel_tools?.serialized, true, "mutating panel serialised");
	if (claude.calls[0].options.systemPrompt === claude.calls[1].options.systemPrompt) throw new Error("panel and judge prompts differ");
});

test("runFusion treats blank panel output as failure and honours the armed profile", async () => {
	const config: FusionConfig = {
		panel: ["claude/opus"],
		panels: { alt: { models: ["openrouter/a/b", "openrouter/c/d"], judge: "openrouter/a/b" } },
	};
	const claude = fakeBackend("claude", { opus: { text: "   " } });
	const openrouter = fakeBackend("openrouter", { "a/b": { text: "one answer, long enough to be excerpted" }, "c/d": { text: "two answer, long enough to be excerpted" } });
	const blank = await runFusion(input(config, fakeBackends(claude, openrouter)));
	eq(blank.details.status, "error", "blank is a failure");
	eq(blank.details.failed_models?.[0].error, "empty response", "empty response reason");

	openrouter.calls.length = 0;
	const armed = await runFusion(input(config, fakeBackends(claude, openrouter), { overrides: { panel_profile: "alt" } }));
	eq(armed.details.panel_profile, "alt", "armed profile used");
	eq(openrouter.calls.map((c) => c.model), ["a/b", "c/d", "a/b"], "two panelists then judge");
	eq(claude.calls.length, 1, "legacy panel not used for the armed run");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node src/__tests__/fusion.test.ts`
Expected: module not found for `../fusion.ts`.

- [ ] **Step 4: Write src/fusion.ts**

```ts
import { modelDisplay } from "./backends/registry.ts";
import type { Backend, Backends, CallOptions, CallResult } from "./backends/types.ts";
import { PANEL_CONCURRENCY, resolveEffectiveConfig, type ResolvedFusionConfig } from "./config.ts";
import { PanelSelectionError, resolvePanelAndJudge, type ResolveCandidate, type ResolveResult } from "./models.ts";
import {
	FUSION_ANALYSIS_SCHEMA,
	JUDGE_SYSTEM_PROMPT,
	PANEL_SYSTEM_PROMPT,
	PANEL_SYSTEM_PROMPT_WITH_TOOLS,
	truncateForJudge,
} from "./prompts.ts";
import { clampMaxToolCalls, isMutatingSelection, MUTATING_TOOL_NAMES, selectionLabel, selectionToNames } from "./tools.ts";
import type {
	EffectiveConfigResult,
	FusionAnalysis,
	FusionConfig,
	FusionDetails,
	FusionOptions,
	FusionResult,
	ModelRef,
	PanelResult,
	ThinkingLevel,
	ToolSelection,
} from "./types.ts";
import { extractJson, mapWithConcurrencyLimit, truncateToBytes } from "./utils.ts";

const TOOL_RESULT_EXCERPT_BYTES = 480;

const ANALYSIS_KEYS = ["consensus", "contradictions", "partial_coverage", "unique_insights", "blind_spots"] as const;

export function parseFusionAnalysis(value: unknown): FusionAnalysis | undefined {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	if (!ANALYSIS_KEYS.some((key) => Array.isArray(obj[key]))) return undefined;
	return {
		consensus: Array.isArray(obj.consensus) ? obj.consensus : [],
		contradictions: Array.isArray(obj.contradictions) ? obj.contradictions : [],
		partial_coverage: Array.isArray(obj.partial_coverage) ? obj.partial_coverage : [],
		unique_insights: Array.isArray(obj.unique_insights) ? obj.unique_insights : [],
		blind_spots: Array.isArray(obj.blind_spots) ? obj.blind_spots : [],
	};
}

export function compactFusionToolText(details: FusionDetails): string {
	const passThroughSingle = details.responses.length === 1 && !details.analysis;
	return JSON.stringify(
		{
			status: details.status,
			analysis: details.analysis,
			excerpts: details.responses.map((r) => ({
				model: r.model,
				excerpt: passThroughSingle ? r.content : truncateToBytes(r.content, TOOL_RESULT_EXCERPT_BYTES, "…"),
				...(r.tools ? { tools: r.tools } : {}),
			})),
			...(details.failed_models ? { failed_models: details.failed_models } : {}),
			panel_models: details.panel_models,
			judge_model: details.judge_model,
			...(details.panel_profile ? { panel_profile: details.panel_profile } : {}),
			...(details.warnings ? { warnings: details.warnings } : {}),
			...(details.error ? { error: details.error } : {}),
			...(details.failure_reason ? { failure_reason: details.failure_reason } : {}),
		},
		null,
		2,
	);
}

function fusionToolResult(details: FusionDetails): FusionResult {
	return { content: [{ type: "text", text: compactFusionToolText(details) }], details };
}

export function emptyPanelError(content: string, capped: boolean): string | undefined {
	if (content.trim()) return undefined;
	return capped ? "no text answer (tool-call budget or loop guard hit)" : "empty response";
}

export interface PanelReasoningPlan {
	requested?: ThinkingLevel;
	effective: Record<string, ThinkingLevel | null>;
	warnings: string[];
}

export function resolvePanelReasoning(panel: ModelRef[], backends: Backends, requested: ThinkingLevel | undefined): PanelReasoningPlan {
	const effective: Record<string, ThinkingLevel | null> = {};
	const warnings: string[] = [];
	for (const ref of panel) {
		const name = modelDisplay(ref);
		if (!requested) {
			effective[name] = null;
			continue;
		}
		const support = backends[ref.backend].supportsReasoning(ref, requested);
		effective[name] = support.effective ?? null;
		if (support.warning) warnings.push(support.warning);
	}
	return { requested, effective, warnings };
}

export type FusionSelectionResult =
	| { ok: true; config: ResolvedFusionConfig; resolution: ResolveResult }
	| { ok: false; result: FusionResult };

export function resolveFusionSelection(rawConfig: FusionConfig, overrides: FusionOptions): FusionSelectionResult {
	const explicitProfile = overrides.panel_profile;
	const effective = resolveEffectiveConfig(rawConfig, explicitProfile);
	if (!effective.ok) {
		return selectionFailure(effective.error.message, effective.error.panelName, effective.warnings);
	}

	let legacyResult: EffectiveConfigResult = effective;
	if (effective.source === "default") {
		const legacyRaw = { ...rawConfig };
		delete legacyRaw.defaultPanel;
		legacyResult = resolveEffectiveConfig(legacyRaw);
	}
	if (!legacyResult.ok) {
		return selectionFailure(legacyResult.error.message, legacyResult.error.panelName, legacyResult.warnings);
	}
	const legacy = legacyResult;

	const candidates: ResolveCandidate[] = [];
	if (explicitProfile) {
		candidates.push({
			source: "explicit",
			profileName: effective.profileName,
			panel: effective.config.panel ?? [],
			judge: effective.config.judge,
			maxPanelModels: effective.config.maxPanelModels,
			strict: true,
		});
	} else {
		if (effective.source === "default") {
			candidates.push({
				source: "default",
				profileName: effective.profileName,
				panel: effective.config.panel ?? [],
				judge: effective.config.judge,
				maxPanelModels: effective.config.maxPanelModels,
			});
		}
		if (legacy.config.panel?.length) {
			candidates.push({
				source: "legacy",
				panel: legacy.config.panel,
				judge: legacy.config.judge,
				maxPanelModels: legacy.config.maxPanelModels,
			});
		}
	}

	try {
		const resolution = resolvePanelAndJudge({ candidates, warnings: effective.warnings });
		const config = resolution.source === "explicit" || resolution.source === "default" ? effective.config : legacy.config;
		return { ok: true, config, resolution };
	} catch (error) {
		if (error instanceof PanelSelectionError) {
			return selectionFailure(error.message, error.profileName, error.warnings);
		}
		throw error;
	}
}

function selectionFailure(message: string, profileName: string | undefined, warnings: string[]): FusionSelectionResult {
	const details: FusionDetails = {
		status: "error",
		responses: [],
		...(profileName ? { panel_profile: profileName } : {}),
		...(warnings.length ? { warnings } : {}),
		error: message,
		failure_reason: "unexpected_error",
	};
	return { ok: false, result: fusionToolResult(details) };
}

export type FusionPhase = "resolving" | "judging" | "single_response";

export interface RunFusionInput {
	projectDir: string;
	config: FusionConfig;
	backends: Backends;
	prompt: string;
	overrides: FusionOptions;
	consented: boolean;
	signal?: AbortSignal;
	onProgress?: (message: string, phase: FusionPhase) => void;
}

async function callWithTimeout(
	backend: Backend,
	ref: ModelRef,
	options: Omit<CallOptions, "signal">,
	timeoutSeconds: number,
	signal: AbortSignal | undefined,
): Promise<CallResult> {
	const signals = [AbortSignal.timeout(timeoutSeconds * 1000)];
	if (signal) signals.push(signal);
	return backend.call(ref, { ...options, signal: AbortSignal.any(signals) });
}

export async function runFusion(input: RunFusionInput): Promise<FusionResult> {
	const { backends, prompt, signal } = input;
	const selection = resolveFusionSelection(input.config, input.overrides);
	if (!selection.ok) return selection.result;
	const { config, resolution } = selection;
	const { panel, judge, warnings, profileName } = resolution;

	const panelReasoning = resolvePanelReasoning(panel, backends, config.panelReasoning);
	warnings.push(...panelReasoning.warnings);
	const panelReasoningDetails = panelReasoning.requested
		? { requested: panelReasoning.requested, effective: panelReasoning.effective }
		: undefined;

	let toolSelection: ToolSelection | undefined = config.panelTools;
	const hasConsent = input.consented || config.panelToolsConsent === true;
	if (isMutatingSelection(toolSelection) && !hasConsent) {
		const readOnly = selectionToNames(toolSelection).filter((n) => !MUTATING_TOOL_NAMES.includes(n));
		toolSelection = readOnly.length ? readOnly : "none";
		warnings.push("Mutating panel tools require consent (set panelToolsConsent in fusion.json); using read-only subset.");
	}
	const toolNames = selectionToNames(toolSelection);
	const toolsRequested = toolNames.length > 0;
	const maxToolCalls = clampMaxToolCalls(config.maxToolCalls);
	const mutating = isMutatingSelection(toolSelection);
	const panelConcurrency = mutating ? 1 : PANEL_CONCURRENCY;
	if (toolsRequested) {
		for (const ref of panel) {
			if (!backends[ref.backend].supportsTools) {
				warnings.push(`${modelDisplay(ref)} runs without panel tools (${ref.backend} backend has no tools).`);
			}
		}
	}

	const panelModelNames = panel.map(modelDisplay);
	const judgeName = modelDisplay(judge);
	const toolsLabel = toolsRequested ? ` | tools: ${selectionLabel(toolSelection)}·${maxToolCalls}${mutating ? " (serialized)" : ""}` : "";
	const panelReasoningLabel = panelReasoningDetails
		? ` | panel reasoning: ${panelReasoningDetails.requested} (${Object.entries(panelReasoningDetails.effective).map(([name, level]) => `${name}=${level ?? "off"}`).join(", ")})`
		: "";
	const judgeReasoningLabel = config.judgeReasoning ? ` | judge reasoning requested: ${config.judgeReasoning}` : "";

	input.onProgress?.(
		`Fusion panel: ${panelModelNames.join(", ")} | judge: ${judgeName}${profileName ? ` | named panel: ${profileName}` : ""}${panelReasoningLabel}${judgeReasoningLabel}${toolsLabel}${warnings.length > 0 ? " | warnings: " + warnings.join("; ") : ""}`,
		"resolving",
	);

	const rawPanelResults = await mapWithConcurrencyLimit(panel, panelConcurrency, async (ref): Promise<PanelResult> => {
		const base = { model: modelDisplay(ref) };
		const backend = backends[ref.backend];
		const effectiveReasoning = panelReasoning.effective[base.model] ?? undefined;
		const tools = backend.supportsTools ? toolNames : [];
		try {
			const result = await callWithTimeout(
				backend,
				ref,
				{
					systemPrompt: tools.length ? PANEL_SYSTEM_PROMPT_WITH_TOOLS : PANEL_SYSTEM_PROMPT,
					userText: prompt,
					maxTokens: config.maxPanelOutputTokens,
					temperature: config.temperature,
					reasoning: effectiveReasoning,
					tools,
					maxToolCalls,
					cwd: input.projectDir,
				},
				config.timeoutSeconds,
				signal,
			);
			if (result.warnings) warnings.push(...result.warnings);
			const error = emptyPanelError(result.text, result.tools?.capped ?? false);
			return { ...base, content: error ? "" : result.text, ...(error ? { error } : {}), ...(result.tools ? { tools: result.tools } : {}) };
		} catch (err) {
			return { ...base, content: "", error: err instanceof Error ? err.message : String(err) };
		}
	});

	const successful = rawPanelResults.filter((r): r is PanelResult & { error: undefined } => !r.error);
	const failed = rawPanelResults.filter((r): r is PanelResult & { error: string } => !!r.error);
	const failedDetails = failed.map((f) => ({ model: f.model, error: f.error, ...(f.tools ? { tools: f.tools } : {}) }));

	if (successful.length === 0) {
		return fusionToolResult({
			status: "error",
			responses: [],
			failed_models: failedDetails,
			panel_models: panelModelNames,
			judge_model: judgeName,
			...(profileName ? { panel_profile: profileName } : {}),
			...(panelReasoningDetails ? { panel_reasoning: panelReasoningDetails } : {}),
			...(warnings.length > 0 ? { warnings } : {}),
			error: "all panel models failed",
			failure_reason: classifyAllPanelFailure(failed),
		});
	}

	input.onProgress?.(
		successful.length === 1
			? `Panel complete (${successful.length}/${panel.length}). Only one model succeeded; skipping judge synthesis.`
			: `Panel complete (${successful.length}/${panel.length}). Running judge...`,
		successful.length === 1 ? "single_response" : "judging",
	);

	let analysis: FusionAnalysis | undefined;
	let judgeFailureReason: FusionDetails["failure_reason"];
	let judgeReasoningDetails: FusionDetails["judge_reasoning"];
	if (successful.length >= 2) {
		const judgeBackend = backends[judge.backend];
		const judgeReasoning = config.judgeReasoning ? judgeBackend.supportsReasoning(judge, config.judgeReasoning) : {};
		if (judgeReasoning.warning) warnings.push(judgeReasoning.warning);
		if (config.judgeReasoning) {
			judgeReasoningDetails = { requested: config.judgeReasoning, effective: judgeReasoning.effective ?? null };
		}
		const judgeBudgetPerResponse = Math.max(
			1024,
			Math.floor((await judgeBackend.contextWindow(judge)) / Math.max(successful.length * 2, 8)),
		);
		const judgeUserText =
			`Task:\n${prompt}\n\n` +
			successful.map((r) => `--- Response from ${r.model} ---\n${truncateForJudge(r.content, judgeBudgetPerResponse)}`).join("\n\n");

		try {
			const judgeResult = await callWithTimeout(
				judgeBackend,
				judge,
				{
					systemPrompt: JUDGE_SYSTEM_PROMPT,
					userText: judgeUserText,
					maxTokens: config.maxCompletionTokens,
					temperature: config.temperature,
					reasoning: judgeReasoning.effective,
					tools: [],
					maxToolCalls,
					jsonSchema: FUSION_ANALYSIS_SCHEMA,
					cwd: input.projectDir,
				},
				config.timeoutSeconds,
				signal,
			);
			if (judgeResult.warnings) warnings.push(...judgeResult.warnings);
			analysis = parseFusionAnalysis(judgeResult.structured ?? extractJson(judgeResult.text));
			if (!analysis) {
				warnings.push("Judge returned unparseable JSON; analysis is unavailable. Use /fusion-report for raw panel text.");
				judgeFailureReason = "unexpected_error";
			}
		} catch (err) {
			console.error("[claude-fusion] judge failed:", err);
			warnings.push("Judge call failed; analysis is unavailable. Use /fusion-report for raw panel text.");
			judgeFailureReason = "unexpected_error";
		}
	}

	return fusionToolResult({
		status: "ok",
		analysis,
		responses: successful.map((r) => ({ model: r.model, content: r.content, ...(r.tools ? { tools: r.tools } : {}) })),
		...(failed.length > 0 ? { failed_models: failedDetails } : {}),
		panel_models: panelModelNames,
		judge_model: judgeName,
		...(profileName ? { panel_profile: profileName } : {}),
		...(panelReasoningDetails ? { panel_reasoning: panelReasoningDetails } : {}),
		...(judgeReasoningDetails ? { judge_reasoning: judgeReasoningDetails } : {}),
		...(toolsRequested ? { panel_tools: { mode: selectionLabel(toolSelection), max_tool_calls: maxToolCalls, serialized: mutating } } : {}),
		...(warnings.length > 0 ? { warnings } : {}),
		...(judgeFailureReason ? { failure_reason: judgeFailureReason } : {}),
	});
}

function classifyAllPanelFailure(failed: PanelResult[]): FusionDetails["failure_reason"] {
	const messages = failed.map((f) => (f.error ?? "").toLowerCase());
	if (messages.some((m) => m.includes("credit") || m.includes("quota") || m.includes("billing"))) {
		return "insufficient_credits";
	}
	if (messages.some((m) => m.includes("rate limit") || m.includes("429"))) {
		return "rate_limited";
	}
	return "all_panels_failed";
}
```

- [ ] **Step 5: Run check and tests**

Run: `npm run check && node src/__tests__/fusion.test.ts && npm test`
Expected: all `✓`. Note: the "strips mutating tools" test scripts a judge with `EMPTY_ANALYSIS` text and no `structured`, so `extractJson` is exercised there; the first `runFusion` test exercises the `structured` path.

- [ ] **Step 6: Commit**

```bash
git add src/fusion.ts src/__tests__/_fake_backend.ts src/__tests__/fusion.test.ts
git commit -m "Add fusion pipeline over backends"
```

---

### Task 9: Session state

**Files:**
- Create: `src/state.ts`
- Test: `src/__tests__/state.test.ts`

**Interfaces:**
- Consumes: `FusionMode` from `types.ts`
- Produces: `SessionState { mode: FusionMode; armedPanel?: string }`, `DEFAULT_STATE`, `stateDir(env?)`, `resolveSessionId(env?, dir?)`, `writeCurrentSession(sessionId, dir?)`, `readState(sessionId, dir?)`, `writeState(sessionId, patch, dir?)`, `clearState(sessionId, dir?)`, `consumeArmedPanel(sessionId, dir?)`

**Depends on:** Task 2

- [ ] **Step 1: Write the failing test**

`src/__tests__/state.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearState, consumeArmedPanel, readState, resolveSessionId, stateDir, writeCurrentSession, writeState } from "../state.ts";
import { eq, test } from "./_harness.ts";

function withDir(fn: (dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "claude-fusion-state-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("stateDir honours FUSION_DATA_DIR and defaults under ~/.claude", () => {
	eq(stateDir({ FUSION_DATA_DIR: "/x/y" }), "/x/y", "override");
	if (!stateDir({}).endsWith(join(".claude", "claude-fusion"))) throw new Error(`unexpected default: ${stateDir({})}`);
});

test("readState defaults to available and survives missing or corrupt files", () => {
	withDir((dir) => {
		eq(readState("s1", dir), { mode: "available" }, "missing file");
		mkdirSync(join(dir, "sessions"));
		writeFileSync(join(dir, "sessions", "s1.json"), "{not json");
		eq(readState("s1", dir), { mode: "available" }, "corrupt file");
		writeFileSync(join(dir, "sessions", "s1.json"), JSON.stringify({ mode: "bogus", armedPanel: 3 }));
		eq(readState("s1", dir), { mode: "available" }, "invalid values normalised");
	});
});

test("writeState merges, clearState removes, consumeArmedPanel is one-shot", () => {
	withDir((dir) => {
		eq(writeState("s1", { mode: "forced" }, dir), { mode: "forced" }, "write mode");
		eq(writeState("s1", { armedPanel: "quality" }, dir), { mode: "forced", armedPanel: "quality" }, "merge armed");
		eq(consumeArmedPanel("s1", dir), "quality", "consumed");
		eq(readState("s1", dir), { mode: "forced" }, "armed cleared, mode kept");
		eq(consumeArmedPanel("s1", dir), undefined, "second consume empty");
		eq(writeState("s1", { mode: "off", armedPanel: undefined }, dir), { mode: "off" }, "explicit undefined clears");
		clearState("s1", dir);
		eq(existsSync(join(dir, "sessions", "s1.json")), false, "file removed");
		clearState("s1", dir);
	});
});

test("session ids are sanitised into file names", () => {
	withDir((dir) => {
		writeState("../evil/../id", { mode: "off" }, dir);
		eq(existsSync(join(dir, "sessions", ".._evil_.._id.json")), true, "sanitised path");
	});
});

test("resolveSessionId prefers the env var then the current-session pointer", () => {
	withDir((dir) => {
		eq(resolveSessionId({}, dir), undefined, "nothing");
		writeCurrentSession("from-hook", dir);
		eq(resolveSessionId({}, dir), "from-hook", "pointer");
		eq(resolveSessionId({ CLAUDE_CODE_SESSION_ID: "from-env" }, dir), "from-env", "env wins");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node src/__tests__/state.test.ts`
Expected: module not found.

- [ ] **Step 3: Write src/state.ts**

```ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FusionMode } from "./types.ts";

export interface SessionState {
	mode: FusionMode;
	armedPanel?: string;
}

export const DEFAULT_STATE: SessionState = { mode: "available" };

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.FUSION_DATA_DIR ?? join(homedir(), ".claude", "claude-fusion");
}

function sessionPath(dir: string, sessionId: string): string {
	return join(dir, "sessions", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function normalize(value: unknown): SessionState {
	if (typeof value !== "object" || value === null) return { ...DEFAULT_STATE };
	const record = value as Record<string, unknown>;
	const mode: FusionMode = record.mode === "forced" || record.mode === "off" ? record.mode : "available";
	return {
		mode,
		...(typeof record.armedPanel === "string" && record.armedPanel ? { armedPanel: record.armedPanel } : {}),
	};
}

export function resolveSessionId(env: NodeJS.ProcessEnv = process.env, dir: string = stateDir(env)): string | undefined {
	if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
	try {
		const id = readFileSync(join(dir, "current-session"), "utf8").trim();
		return id || undefined;
	} catch {
		return undefined;
	}
}

export function writeCurrentSession(sessionId: string, dir: string = stateDir()): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "current-session"), sessionId);
}

export function readState(sessionId: string, dir: string = stateDir()): SessionState {
	try {
		return normalize(JSON.parse(readFileSync(sessionPath(dir, sessionId), "utf8")));
	} catch {
		return { ...DEFAULT_STATE };
	}
}

export function writeState(sessionId: string, patch: Partial<SessionState>, dir: string = stateDir()): SessionState {
	const next = normalize({ ...readState(sessionId, dir), ...patch });
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(sessionPath(dir, sessionId), JSON.stringify(next));
	return next;
}

export function clearState(sessionId: string, dir: string = stateDir()): void {
	rmSync(sessionPath(dir, sessionId), { force: true });
}

export function consumeArmedPanel(sessionId: string, dir: string = stateDir()): string | undefined {
	const armed = readState(sessionId, dir).armedPanel;
	if (armed) writeState(sessionId, { armedPanel: undefined }, dir);
	return armed;
}
```

- [ ] **Step 4: Run check and tests**

Run: `npm run check && node src/__tests__/state.test.ts`
Expected: all `✓`.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/__tests__/state.test.ts
git commit -m "Add per-session fusion state"
```

---

### Task 10: CLI for hooks and commands

**Files:**
- Create: `src/cli.ts`
- Test: `src/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: `configPaths`, `generateConfigExample`, `loadConfigWithPath` (Task 3); `resolveFusionSelection` (Task 8); `modelDisplay` (Task 4); state functions (Task 9); `selectionLabel`, `clampMaxToolCalls` (Task 4)
- Produces: `FORCE_PREAMBLE`, `isForcedPrompt(text)`, `forceFusionPrompt(prompt)`, `parseModeWord(word)`, `CommandContext { state; config; setState(patch) }`, `fusionCommand(args, ctx): string`, `statusText(state, config, configPath, projectDir): string`, `initCommand(projectDir): string`, `HookInput`, `userPromptSubmitHook(input, state)`, `preToolUseHook(state)`, and the `main(argv)` dispatcher (runs only when executed directly)

**Depends on:** Task 8, Task 9

- [ ] **Step 1: Write the failing test**

`src/__tests__/cli.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FORCE_PREAMBLE,
	forceFusionPrompt,
	fusionCommand,
	initCommand,
	parseModeWord,
	preToolUseHook,
	statusText,
	userPromptSubmitHook,
	type CommandContext,
} from "../cli.ts";
import type { SessionState } from "../state.ts";
import type { FusionConfig } from "../types.ts";
import { eq, test } from "./_harness.ts";

const config: FusionConfig = {
	panels: { quality: { models: ["claude/opus", "openrouter/a/b"], judge: "claude/sonnet" }, broken: { models: ["nope"] } },
	defaultPanel: "quality",
	panelTools: "readonly",
};

function ctx(state: SessionState, cfg: FusionConfig = config): CommandContext & { writes: Array<Partial<SessionState>> } {
	const writes: Array<Partial<SessionState>> = [];
	return { state, config: cfg, writes, setState: (patch) => writes.push(patch) };
}

test("parseModeWord accepts the pi-fusion aliases", () => {
	eq(parseModeWord("ON"), "forced", "on");
	eq(parseModeWord("force"), "forced", "force");
	eq(parseModeWord("auto"), "available", "auto");
	eq(parseModeWord("disabled"), "off", "disabled");
	eq(parseModeWord("hello"), undefined, "not a mode");
});

test("forceFusionPrompt wraps once and is idempotent", () => {
	const forced = forceFusionPrompt("what is x?");
	if (!forced.startsWith(FORCE_PREAMBLE)) throw new Error("missing preamble");
	if (!forced.endsWith("\n\nwhat is x?")) throw new Error("prompt not appended");
	if (forced.includes("context_mode")) throw new Error("pi-only instruction leaked");
	eq(forceFusionPrompt(forced), forced, "idempotent");
});

test("/fusion with no args toggles available and forced, requiring a panel for forced", () => {
	const on = ctx({ mode: "available" });
	eq(fusionCommand("", on), "Fusion mode is now forced. Tell the user.", "toggle on");
	eq(on.writes, [{ mode: "forced", armedPanel: undefined }], "state written");
	const off = ctx({ mode: "forced" });
	eq(fusionCommand("  ", off), "Fusion mode is now available. Tell the user.", "toggle back");
	const noPanel = ctx({ mode: "available" }, {});
	if (!fusionCommand("", noPanel).startsWith("Cannot enable forced mode: No panel configured")) throw new Error("expected panel error");
	eq(noPanel.writes, [], "nothing written");
	const explicitOff = ctx({ mode: "available" }, {});
	eq(fusionCommand("off", explicitOff), "Fusion mode is now off. Tell the user.", "off never needs a panel");
});

test("/fusion <name> arms a valid named panel and rejects a broken one", () => {
	const good = ctx({ mode: "available" });
	eq(fusionCommand("quality", good), 'Named panel "quality" armed for the next fusion call. Tell the user.', "armed");
	eq(good.writes, [{ armedPanel: "quality" }], "armed written");
	const bad = ctx({ mode: "available" });
	if (!fusionCommand("broken", bad).startsWith('Named panel "broken" cannot be used:')) throw new Error("expected rejection");
	eq(bad.writes, [], "nothing written");
});

test("/fusion <prompt> instructs a one-shot run unless fusion is off", () => {
	const run = ctx({ mode: "available" });
	eq(fusionCommand("compare A and B", run), "Run the fusion tool now with exactly this prompt, then answer the user in your own words:\n\ncompare A and B", "prompt");
	eq(run.writes, [], "prompt does not touch state");
	const off = ctx({ mode: "off" });
	if (!fusionCommand("compare A and B", off).startsWith("Fusion is off")) throw new Error("expected off message");
});

test("statusText reports mode, config path, panel and tools", () => {
	const text = statusText({ mode: "forced", armedPanel: "quality" }, config, "/p/.claude/fusion.json", "/p");
	for (const needle of ["Fusion mode: forced", "Armed panel: quality", "Config: /p/.claude/fusion.json", "Panel: claude/opus, openrouter/a/b (named panel \"quality\")", "Judge: claude/sonnet", "Panel tools: readonly (max 16 turns, consent no)"]) {
		if (!text.includes(needle)) throw new Error(`missing ${needle} in:\n${text}`);
	}
	const none = statusText({ mode: "available" }, {}, undefined, "/p");
	if (!none.includes("Config: none found")) throw new Error("expected none found");
	if (!none.includes("Panel: unavailable (No panel configured")) throw new Error("expected unavailable panel");
});

test("initCommand writes the example once and never overwrites", () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-fusion-init-"));
	try {
		const first = initCommand(dir);
		if (!first.startsWith(`Wrote ${join(dir, ".claude", "fusion.json")}`)) throw new Error(first);
		const written = JSON.parse(readFileSync(join(dir, ".claude", "fusion.json"), "utf8")) as FusionConfig;
		eq(written.defaultPanel, "default", "example written");
		const second = initCommand(dir);
		if (!second.includes("already exists")) throw new Error(second);
		eq(existsSync(join(dir, ".claude", "fusion.json")), true, "still there");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("userPromptSubmitHook rewrites only plain prompts in forced mode", () => {
	eq(userPromptSubmitHook({ prompt: "hi" }, { mode: "available" }), undefined, "not forced");
	eq(userPromptSubmitHook({ prompt: "/fusion off" }, { mode: "forced" }), undefined, "commands pass");
	eq(userPromptSubmitHook({ prompt: "   " }, { mode: "forced" }), undefined, "blank passes");
	eq(userPromptSubmitHook({ prompt: forceFusionPrompt("x") }, { mode: "forced" }), undefined, "already forced passes");
	eq(userPromptSubmitHook({ prompt: "hi" }, { mode: "forced" }), {
		hookSpecificOutput: { hookEventName: "UserPromptSubmit", updatedInput: { prompt: forceFusionPrompt("hi") } },
	}, "rewritten");
});

test("preToolUseHook denies only when off", () => {
	eq(preToolUseHook({ mode: "forced" }), undefined, "forced allows");
	eq(preToolUseHook({ mode: "off" }), {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: "Fusion is off for this session. Use /fusion available or /fusion on to re-enable it.",
		},
	}, "off denies");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node src/__tests__/cli.test.ts`
Expected: module not found.

- [ ] **Step 3: Write src/cli.ts**

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { modelDisplay } from "./backends/registry.ts";
import { configPaths, generateConfigExample, loadConfigWithPath } from "./config.ts";
import { resolveFusionSelection } from "./fusion.ts";
import { clearState, readState, resolveSessionId, writeCurrentSession, writeState, type SessionState } from "./state.ts";
import { clampMaxToolCalls, selectionLabel } from "./tools.ts";
import type { FusionConfig, FusionMode } from "./types.ts";

export const FORCE_PREAMBLE = "Use the fusion tool for the following prompt before answering.";

export function isForcedPrompt(text: string): boolean {
	return text.trimStart().startsWith(FORCE_PREAMBLE);
}

export function forceFusionPrompt(prompt: string): string {
	if (isForcedPrompt(prompt)) return prompt;
	return [
		FORCE_PREAMBLE,
		"After the fusion tool returns, write the final answer yourself in your normal assistant voice.",
		"Do not simply paste the fusion JSON or raw panel responses unless the user explicitly asks for diagnostics.",
		"",
		prompt,
	].join("\n");
}

export function parseModeWord(word: string): FusionMode | undefined {
	const lower = word.trim().toLowerCase();
	if (["off", "disable", "disabled"].includes(lower)) return "off";
	if (["available", "auto"].includes(lower)) return "available";
	if (["on", "force", "forced"].includes(lower)) return "forced";
	return undefined;
}

export interface CommandContext {
	state: SessionState;
	config: FusionConfig;
	setState(patch: Partial<SessionState>): void;
}

function panelError(config: FusionConfig, profile?: string): string | undefined {
	const selection = resolveFusionSelection(config, profile ? { panel_profile: profile } : {});
	return selection.ok ? undefined : selection.result.details.error ?? "Fusion panel could not be resolved.";
}

export function fusionCommand(args: string, ctx: CommandContext): string {
	const text = args.trim();
	const mode = text ? parseModeWord(text) : undefined;
	if (!text || mode) {
		const next: FusionMode = mode ?? (ctx.state.mode === "forced" ? "available" : "forced");
		if (next === "forced") {
			const error = panelError(ctx.config);
			if (error) return `Cannot enable forced mode: ${error}`;
		}
		ctx.setState({ mode: next, armedPanel: undefined });
		return `Fusion mode is now ${next}. Tell the user.`;
	}
	if (ctx.state.mode === "off") {
		return "Fusion is off for this session. Tell the user to run /fusion available or /fusion on first.";
	}
	if (ctx.config.panels && Object.hasOwn(ctx.config.panels, text)) {
		const error = panelError(ctx.config, text);
		if (error) return `Named panel "${text}" cannot be used: ${error}`;
		ctx.setState({ armedPanel: text });
		return `Named panel "${text}" armed for the next fusion call. Tell the user.`;
	}
	return `Run the fusion tool now with exactly this prompt, then answer the user in your own words:\n\n${text}`;
}

export function statusText(state: SessionState, config: FusionConfig, configPath: string | undefined, projectDir: string): string {
	const lines = [`Fusion mode: ${state.mode}`];
	if (state.armedPanel) lines.push(`Armed panel: ${state.armedPanel}`);
	lines.push(`Config: ${configPath ?? `none found (looked in ${configPaths(projectDir).join(", ")})`}`);
	const selection = resolveFusionSelection(config, {});
	if (!selection.ok) {
		lines.push(`Panel: unavailable (${selection.result.details.error})`);
		return lines.join("\n");
	}
	const { resolution, config: resolved } = selection;
	lines.push(`Panel: ${resolution.panel.map(modelDisplay).join(", ")}${resolution.profileName ? ` (named panel "${resolution.profileName}")` : ""}`);
	lines.push(`Judge: ${modelDisplay(resolution.judge)}`);
	lines.push(`Panel reasoning: ${resolved.panelReasoning ?? "off"}`);
	lines.push(`Judge reasoning: ${resolved.judgeReasoning ?? "off"}`);
	lines.push(`Panel tools: ${selectionLabel(resolved.panelTools)} (max ${clampMaxToolCalls(resolved.maxToolCalls)} turns, consent ${resolved.panelToolsConsent ? "yes" : "no"})`);
	if (resolution.warnings.length) lines.push(`Warnings: ${resolution.warnings.join("; ")}`);
	return lines.join("\n");
}

export function initCommand(projectDir: string): string {
	const dir = join(projectDir, ".claude");
	const path = join(dir, "fusion.json");
	const example = JSON.stringify(generateConfigExample(), null, 2);
	if (existsSync(path)) return `${path} already exists; not overwriting. Example config:\n${example}`;
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, example + "\n");
	return `Wrote ${path}. Edit the panel and judge ids, and set OPENROUTER_API_KEY in your shell for openrouter/* models.`;
}

export interface HookInput {
	session_id?: string;
	hook_event_name?: string;
	prompt?: string;
	cwd?: string;
}

export function userPromptSubmitHook(input: HookInput, state: SessionState): Record<string, unknown> | undefined {
	const prompt = input.prompt ?? "";
	if (state.mode !== "forced") return undefined;
	if (!prompt.trim() || prompt.trimStart().startsWith("/") || isForcedPrompt(prompt)) return undefined;
	return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", updatedInput: { prompt: forceFusionPrompt(prompt) } } };
}

export function preToolUseHook(state: SessionState): Record<string, unknown> | undefined {
	if (state.mode !== "off") return undefined;
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: "Fusion is off for this session. Use /fusion available or /fusion on to re-enable it.",
		},
	};
}

async function readStdin(): Promise<string> {
	let data = "";
	for await (const chunk of process.stdin) data += chunk;
	return data;
}

async function runHook(event: string | undefined): Promise<void> {
	let input: HookInput = {};
	try {
		input = JSON.parse(await readStdin()) as HookInput;
	} catch {
		return;
	}
	const sessionId = input.session_id;
	if (!sessionId) return;
	const name = event ?? input.hook_event_name;
	if (name === "SessionEnd") {
		clearState(sessionId);
		return;
	}
	writeCurrentSession(sessionId);
	const state = readState(sessionId);
	const output = name === "UserPromptSubmit" ? userPromptSubmitHook(input, state) : name === "PreToolUse" ? preToolUseHook(state) : undefined;
	if (output) process.stdout.write(JSON.stringify(output));
}

export async function main(argv: string[]): Promise<void> {
	const [command, ...rest] = argv;
	const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
	if (command === "hook") {
		await runHook(rest[0]);
		return;
	}
	if (command === "init") {
		console.log(initCommand(projectDir));
		return;
	}
	const { config, path } = loadConfigWithPath(projectDir);
	const sessionId = resolveSessionId();
	if (!sessionId) {
		console.log("claude-fusion could not determine the session id (CLAUDE_CODE_SESSION_ID is unset and no hook has run yet). Send one message and retry.");
		return;
	}
	const state = readState(sessionId);
	if (command === "status") {
		console.log(statusText(state, config, path, projectDir));
		return;
	}
	if (command === "fusion") {
		console.log(fusionCommand(rest.join(" "), { state, config, setState: (patch) => void writeState(sessionId, patch) }));
		return;
	}
	console.error(`Unknown command: ${command ?? "(none)"}. Expected hook | init | status | fusion.`);
	process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((err) => {
		console.error(err);
		process.exitCode = 1;
	});
}
```

- [ ] **Step 4: Run check and tests**

Run: `npm run check && node src/__tests__/cli.test.ts`
Expected: all `✓`. Confirm importing `cli.ts` from the test did not execute `main` (no "Unknown command" output).

- [ ] **Step 5: Exercise the entry by hand**

```bash
cd /home/dev/code/active/claude-fusion
FUSION_DATA_DIR=/tmp/cf-state CLAUDE_CODE_SESSION_ID=manual node src/cli.ts status
FUSION_DATA_DIR=/tmp/cf-state CLAUDE_CODE_SESSION_ID=manual node src/cli.ts fusion off
echo '{"session_id":"manual","prompt":"hello"}' | FUSION_DATA_DIR=/tmp/cf-state node src/cli.ts hook PreToolUse
echo '{"session_id":"manual"}' | FUSION_DATA_DIR=/tmp/cf-state node src/cli.ts hook SessionEnd
ls /tmp/cf-state/sessions
```

Expected: status prints `Panel: unavailable (No panel configured...` (no config in this repo yet), the mode change prints `Fusion mode is now off`, the PreToolUse hook prints the deny JSON, SessionEnd removes the file so `ls` shows nothing. Clean up with `rm -rf /tmp/cf-state`.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/__tests__/cli.test.ts
git commit -m "Add CLI entry for hooks and slash commands"
```

---

### Task 11: MCP server and plugin wiring

**Files:**
- Create: `src/server.ts`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `hooks/hooks.json`, `commands/fusion.md`, `commands/fusion-status.md`, `commands/fusion-report.md`, `commands/fusion-init.md`

**Interfaces:**
- Consumes: `createClaudeBackend` (Task 6), `createOpenRouterBackend` (Task 7), `loadConfig` (Task 3), `formatResult` (Task 2), `runFusion` (Task 8), `consumeArmedPanel`, `readState`, `resolveSessionId` (Task 9)
- Produces: MCP tools `fusion` and `fusion_report`; the installable plugin

**Depends on:** Task 6, Task 7, Task 8, Task 9, Task 10

- [ ] **Step 1: Check the SDK's handler `extra` type**

Run: `rg -n "signal|sendNotification|_meta" node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts | head -20` and `rg -n "registerTool" node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts | head`. Confirm `RequestHandlerExtra` has `signal: AbortSignal`, `_meta?: { progressToken?: string | number }`, `sendNotification(notification)`. If the `_meta` shape differs, adapt the `progressToken` read in Step 2 to match.

- [ ] **Step 2: Write src/server.ts**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createClaudeBackend } from "./backends/claude.ts";
import { createOpenRouterBackend } from "./backends/openrouter.ts";
import type { Backends } from "./backends/types.ts";
import { loadConfig } from "./config.ts";
import { formatResult } from "./format.ts";
import { runFusion } from "./fusion.ts";
import { consumeArmedPanel, readState, resolveSessionId } from "./state.ts";
import type { FusionResult } from "./types.ts";

const VERSION = "0.1.0";

const FUSION_DESCRIPTION = [
	"Multi-model deliberation tool inspired by OpenRouter Fusion.",
	"Use fusion when a single perspective is not enough: research questions, expert critique, compare/contrast tasks, or decisions where being wrong is expensive.",
	"Runs the prompt against a configured panel of models in parallel, then a judge compares responses and returns structured analysis (consensus, contradictions, partial coverage, unique insights, blind spots).",
	"Panel and judge are configured in .claude/fusion.json or ~/.claude/fusion.json; the tool cannot choose them.",
	"Use it only when a task genuinely benefits from multiple perspectives, not for simple tactical prompts, routine edits, or questions a single model answers well.",
	"Panel and judge calls do not see this conversation. Put any context the panel needs into the prompt.",
].join(" ");

const PROMPT_DESCRIPTION = "The question or task for the panel, including any context it needs.";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const backends: Backends = { claude: createClaudeBackend(), openrouter: createOpenRouterBackend() };
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

function disabledResult(): FusionResult {
	const details = { status: "error" as const, responses: [], error: "fusion disabled", failure_reason: "unexpected_error" as const };
	return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: "fusion disabled" }, null, 2) }], details };
}

async function execute(prompt: string, extra: Extra): Promise<FusionResult> {
	const sessionId = resolveSessionId();
	if (sessionId && readState(sessionId).mode === "off") return disabledResult();
	const armed = sessionId ? consumeArmedPanel(sessionId) : undefined;
	const token = extra._meta?.progressToken;
	let step = 0;
	return runFusion({
		projectDir,
		config: loadConfig(projectDir),
		backends,
		prompt,
		overrides: { panel_profile: armed },
		consented: false,
		signal: extra.signal,
		onProgress: (message) => {
			if (token === undefined) return;
			step++;
			void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message } }).catch(() => {});
		},
	});
}

function toolResult(text: string, result: FusionResult) {
	return { content: [{ type: "text" as const, text }], isError: result.details.status === "error" };
}

function errorResult(err: unknown) {
	const message = err instanceof Error ? err.message : String(err);
	console.error("[claude-fusion] tool failed:", err);
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: message, failure_reason: "unexpected_error" }, null, 2) }],
		isError: true,
	};
}

const server = new McpServer({ name: "claude-fusion", version: VERSION });

server.registerTool(
	"fusion",
	{ description: FUSION_DESCRIPTION, inputSchema: { prompt: z.string().describe(PROMPT_DESCRIPTION) } },
	async ({ prompt }, extra) => {
		try {
			const result = await execute(prompt, extra);
			return toolResult(result.content[0].text, result);
		} catch (err) {
			return errorResult(err);
		}
	},
);

server.registerTool(
	"fusion_report",
	{
		description: "Run fusion and return the full diagnostic report (judge analysis plus every panel response) as markdown. Backs /fusion-report.",
		inputSchema: { prompt: z.string().describe(PROMPT_DESCRIPTION) },
	},
	async ({ prompt }, extra) => {
		try {
			const result = await execute(prompt, extra);
			return toolResult(result.details.status === "error" ? result.content[0].text : formatResult(result.details), result);
		} catch (err) {
			return errorResult(err);
		}
	},
);

await server.connect(new StdioServerTransport());
```

Run `npm run check`. If `inputSchema` as a raw shape is rejected by the installed SDK version, wrap it as `z.object({ prompt: ... })` (v2 alpha shape) and note which in the commit body.

- [ ] **Step 3: Write the plugin manifest files**

`.claude-plugin/plugin.json`:

```json
{
	"name": "claude-fusion",
	"version": "0.1.0",
	"description": "Multi-model deliberation: run a prompt against a panel of models and get a judge's structured comparison.",
	"author": { "name": "callumw-k" },
	"repository": "https://github.com/callumw-k/claude-fusion",
	"license": "MIT",
	"keywords": ["fusion", "multi-model", "openrouter", "deliberation"],
	"mcpServers": "./.mcp.json",
	"hooks": "./hooks/hooks.json"
}
```

`.claude-plugin/marketplace.json`:

```json
{
	"name": "claude-fusion",
	"owner": { "name": "callumw-k" },
	"plugins": [
		{
			"name": "claude-fusion",
			"source": "./",
			"description": "Multi-model deliberation: run a prompt against a panel of models and get a judge's structured comparison."
		}
	]
}
```

`.mcp.json`:

```json
{
	"mcpServers": {
		"fusion": {
			"command": "node",
			"args": ["${CLAUDE_PLUGIN_ROOT}/src/server.ts"],
			"env": {
				"CLAUDE_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}"
			}
		}
	}
}
```

`hooks/hooks.json`:

```json
{
	"hooks": {
		"UserPromptSubmit": [
			{
				"hooks": [
					{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/src/cli.ts", "hook", "UserPromptSubmit"] }
				]
			}
		],
		"PreToolUse": [
			{
				"matcher": "mcp__plugin_claude[-_]fusion_fusion__fusion(_report)?",
				"hooks": [
					{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/src/cli.ts", "hook", "PreToolUse"] }
				]
			}
		],
		"SessionEnd": [
			{
				"hooks": [
					{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/src/cli.ts", "hook", "SessionEnd"] }
				]
			}
		]
	}
}
```

- [ ] **Step 4: Write the commands**

`commands/fusion.md`:

```markdown
---
description: "Fusion mode: /fusion on | available | off, /fusion <panel-name> arms a named panel once, /fusion <prompt> forces one fusion call"
argument-hint: "[on|available|off|<panel-name>|<prompt>]"
---
!node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" fusion "$ARGUMENTS"

Follow the instruction printed above exactly. If it contains a prompt to run, call the fusion tool with that prompt, then answer the user in your own words without pasting the raw JSON. Otherwise report the printed status to the user in one line and do nothing else.
```

`commands/fusion-status.md`:

```markdown
---
description: "Show the fusion mode, config file, panel, judge and tool settings for this session"
---
!node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" status

Show the status printed above to the user verbatim in a code block and do nothing else.
```

`commands/fusion-init.md`:

```markdown
---
description: "Write an example .claude/fusion.json into the current project"
---
!node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" init

Report the result printed above to the user. If a file was written, remind them to set OPENROUTER_API_KEY in their shell for openrouter/* models and to edit the panel to taste.
```

`commands/fusion-report.md`:

```markdown
---
description: "Run fusion on a prompt and print the full diagnostic report (judge analysis plus every panel response)"
argument-hint: "<prompt>"
---
Call the `fusion_report` tool with this exact prompt:

$ARGUMENTS

Print the markdown the tool returns verbatim. Do not summarise or rewrite it.
```

- [ ] **Step 5: Validate and launch**

```bash
cd /home/dev/code/active/claude-fusion && npm run check && npm test && claude plugin validate .
```

Expected: validate reports no errors. If it rejects a `marketplace.json` field, adjust to the shape it names (the manifest is a convenience, not a spec requirement).

Then, in a scratch project that has no `.claude/fusion.json`:

```bash
mkdir -p /tmp/cf-play && cd /tmp/cf-play && git init -q
claude --plugin-dir /home/dev/code/active/claude-fusion -p "/fusion-status" --output-format text
```

Expected: the status block, with `Panel: unavailable (No panel configured...`. This confirms `!` expansion and `${CLAUDE_PLUGIN_ROOT}` inside a command (spec item 2). If the output instead shows the literal `!node ...` line, apply the fallback: add a third tool `fusion_command` to `server.ts` that takes `{ command: "fusion" | "status" | "init", args: string }` and returns `fusionCommand`/`statusText`/`initCommand` output (import them from `./cli.ts`, build `CommandContext` with `readState`/`writeState` and `loadConfigWithPath(projectDir)`), and change the three command files to "Call the `fusion_command` tool with command X and args `$ARGUMENTS`, then follow the instruction it returns."

- [ ] **Step 6: Verify session id plumbing (spec item 1)**

Add a temporary line at the top of `execute` in `server.ts`: `console.error("[claude-fusion] session", process.env.CLAUDE_CODE_SESSION_ID);`. Then in `/tmp/cf-play`:

```bash
claude --plugin-dir /home/dev/code/active/claude-fusion -p "/fusion-init" --output-format text
claude --plugin-dir /home/dev/code/active/claude-fusion -p "/fusion off" --output-format text
claude --plugin-dir /home/dev/code/active/claude-fusion --debug=mcp -p "Use the fusion tool to compare tabs and spaces" --output-format text 2>&1 | rg -n "session|denied|fusion disabled" | head
```

Expected: `/fusion off` reports the mode change; the third run is denied by the PreToolUse hook (or returns `fusion disabled`), and the debug log shows the session id line non-empty. If `CLAUDE_CODE_SESSION_ID` prints `undefined` in the server, the `current-session` pointer fallback is what carried the state; note this in the README's "Concurrent sessions" caveat (Task 12). Remove the temporary line.

Each `-p` run is a new session, so the state written by one run is keyed by that run's id; the third command only sees `off` through the pointer fallback. For a same-session check run `claude --plugin-dir ...` interactively, then `/fusion off`, then ask it to use fusion, then `/fusion available`.

- [ ] **Step 7: End-to-end run with real models**

In `/tmp/cf-play` edit `.claude/fusion.json` to `{"panel": ["claude/haiku", "claude/sonnet"], "judge": "claude/haiku", "maxPanelOutputTokens": 300}` (no OpenRouter key needed), then:

```bash
claude --plugin-dir /home/dev/code/active/claude-fusion -p "/fusion-report Is it better to pin dependency versions exactly or use caret ranges in a library's package.json?" --output-format text
```

Expected: a markdown report with `# Fusion Analysis (2 panel models)`, the five analysis sections (or the "Judge analysis unavailable" line if the judge JSON failed, which is a bug to fix before committing), and two `### claude/...` sections. If `OPENROUTER_API_KEY` is set, repeat with an `openrouter/*` panelist added.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts .claude-plugin .mcp.json hooks commands
git commit -m "Add MCP server, hooks and slash commands"
```

---

### Task 12: README and strict checks

**Files:**
- Create: `README.md`
- Modify: `AGENTS.md` (only if Task 11's fallbacks changed the command mechanism)

**Interfaces:**
- Consumes: everything above
- Produces: user documentation

**Depends on:** Task 11

- [ ] **Step 1: Run the strict pass**

Run: `npm run check:strict`
Expected: clean. Fix any unused import or local it reports (remove only what your own change made unused).

- [ ] **Step 2: Write README.md**

```markdown
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

Or add it as a marketplace: `claude plugin marketplace add callumw-k/claude-fusion` then `claude plugin install claude-fusion`. Run `npm install` in the installed plugin directory once; Claude Code does not install npm dependencies for you.

## Configure

`/fusion-init` writes `.claude/fusion.json` in the project. `~/.claude/fusion.json` is the global fallback. The project file wins when both exist.

Model ids carry their backend:

- `claude/<model>`: runs `claude -p` on your Claude Code login. `opus`, `sonnet`, `haiku` and full ids all work. These panelists can use tools.
- `openrouter/<vendor>/<model>`: the OpenRouter model id, e.g. `openrouter/openai/gpt-5.5`. Text only.

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

| Key | Meaning |
| --- | --- |
| `panels`, `defaultPanel` | Named panels. `panel` and `judge` at the top level are the legacy fallback. |
| `panelReasoning`, `judgeReasoning` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Claude models run `minimal` as `low`. |
| `temperature` | OpenRouter models only. `claude -p` does not accept one. |
| `panelTools` | `none`, `readonly` (`Read,Grep,Glob`), `all` (adds `Bash,Edit,Write`), or a list. Claude panelists only. |
| `panelToolsConsent` | Must be `true` for `all` or any list containing `Bash`, `Edit` or `Write`. Mutating panels run one model at a time. |
| `maxToolCalls` | Passed to `claude -p --max-turns`, so it bounds model turns rather than individual tool calls. |
| `timeoutSeconds` | Per model call. |

## Use

- The model calls `fusion` itself when a question warrants several perspectives. The tool takes only a prompt; panel and judge are always yours to configure.
- `/fusion` toggles between `available` and `forced`. In forced mode every plain prompt is routed through fusion first.
- `/fusion on | available | off`. Off denies the tool for the session.
- `/fusion <panel-name>` arms a named panel for the next fusion call.
- `/fusion <prompt>` runs fusion once on that prompt.
- `/fusion-report <prompt>` prints the full report: the analysis plus every panel response.
- `/fusion-status` shows the mode, config file, resolved panel and judge.

Quotes inside a `/fusion <prompt>` argument are passed through the shell; avoid double quotes or use `/fusion-report`.

## How the Claude backend keeps costs down

Each Claude panelist is a `claude -p` call with `--system-prompt`, `--strict-mcp-config`, `--setting-sources ""` and `--tools` restricted, so it does not load your plugins, skills, MCP servers or `CLAUDE.md`. Measured: a trivial call drops from about 39k input tokens to under 400.

## Session state

Modes and armed panels are stored per session in `~/.claude/claude-fusion/sessions/` (override the directory with `FUSION_DATA_DIR`). Hooks receive the session id directly; the MCP server reads `CLAUDE_CODE_SESSION_ID`, falling back to the id of the session that most recently sent a prompt. With two sessions open at once that fallback can read the other session's mode.

## What is not ported from pi-fusion

Auto-diverse panel selection (OpenRouter models are not "authed", so auto-picking would spend money on arbitrary models), the footer status, the setup TUI, `context_mode: recent`, and tools for OpenRouter panelists.

## Development

`npm run check`, `npm test`, `npm run check:strict`, `npm run validate`. Design notes live in `docs/superpowers/specs/`.
```

- [ ] **Step 3: Reconcile docs with what Task 11 found**

If Task 11 fell back to the `fusion_command` tool, update the "Use" section and `AGENTS.md` to describe it. If the session id fallback was the path taken, keep the "Session state" caveat; otherwise trim it to one sentence.

- [ ] **Step 4: Final verification**

Run: `npm run check:strict && npm test && claude plugin validate .`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md
git commit -m "Add README"
```
