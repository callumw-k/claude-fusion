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

export function buildChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...env };
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
