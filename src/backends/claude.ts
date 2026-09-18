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
		...(options.tools.length > 0 ? ["--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
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
	type?: string;
	subtype?: string;
	is_error?: boolean;
	result?: string;
	structured_output?: unknown;
	num_turns?: number;
	message?: { content?: Array<{ type?: string; text?: string }> };
}

interface ParsedClaudeStream {
	result?: ClaudeJsonResult;
	assistantText: string;
}

function parseObject(candidate: string): ClaudeJsonResult | undefined {
	try {
		const parsed = JSON.parse(candidate) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as ClaudeJsonResult) : undefined;
	} catch {
		return undefined;
	}
}

function assistantText(event: ClaudeJsonResult): string {
	return (event.message?.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function parseClaudeStream(stdout: string): ParsedClaudeStream {
	const whole = parseObject(stdout);
	if (whole) return { result: whole, assistantText: "" };
	let result: ClaudeJsonResult | undefined;
	let last: ClaudeJsonResult | undefined;
	let text = "";
	for (const line of stdout.split("\n")) {
		const event = parseObject(line);
		if (!event) continue;
		last = event;
		if (event.type === "assistant") {
			const spoken = assistantText(event);
			if (spoken) text = spoken;
		} else if (event.type === "result") {
			result = event;
		}
	}
	return { result: result ?? last, assistantText: text };
}

export function parseClaudeOutput(
	stdout: string,
	stderr: string,
	exitCode: number | null,
	options: Pick<CallOptions, "tools" | "maxToolCalls">,
): CallResult {
	const { result: parsed, assistantText: spoken } = parseClaudeStream(stdout);
	if (!parsed) {
		throw new Error(`claude -p produced no JSON result (exit ${exitCode ?? "null"}): ${(stderr || stdout).trim().slice(0, 500)}`);
	}
	const toolsRequested = options.tools.length > 0;
	const hitMaxTurns = parsed.subtype === "error_max_turns";
	const text = parsed.result ?? (hitMaxTurns ? spoken : "");
	const cappedWithAnswer = hitMaxTurns && (toolsRequested || text.trim().length > 0);
	if (!cappedWithAnswer && (exitCode !== 0 || parsed.is_error || parsed.subtype !== "success")) {
		throw new Error(text.trim() || stderr.trim() || `claude -p failed (exit ${exitCode ?? "null"}, ${parsed.subtype ?? "unknown"})`);
	}
	const turns = parsed.num_turns ?? 1;
	const capped = hitMaxTurns || turns >= options.maxToolCalls;
	return {
		text,
		...(parsed.structured_output !== undefined ? { structured: parsed.structured_output } : {}),
		...(toolsRequested ? { tools: { turns, tool_calls: [], capped } } : {}),
	};
}

const CHILD_ENV_STRIPPED = ["OPENROUTER_API_KEY", "CLAUDE_CODE_SESSION_ID"];

export function buildChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child = { ...env };
	for (const key of CHILD_ENV_STRIPPED) delete child[key];
	return child;
}

export function abortError(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason as { name?: string } | undefined;
	return new Error(reason?.name === "TimeoutError" ? "timed out" : "cancelled");
}

function runClaude(spawnImpl: SpawnLike, ref: ModelRef, options: CallOptions): Promise<CallResult> {
	return new Promise((resolve, reject) => {
		const child = spawnImpl("claude", buildClaudeArgs(ref, options), {
			cwd: options.cwd,
			env: buildChildEnv(process.env),
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
				reject(abortError(options.signal));
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
