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
	if (existsSync(path)) return `${path} already exists. Not overwriting. Example config:\n${example}`;
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
