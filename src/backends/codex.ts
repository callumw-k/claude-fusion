import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRef, ThinkingLevel } from "../types.ts";
import { runCli, type SpawnLike } from "./spawn.ts";
import type { Backend, CallOptions, CallResult, ReasoningSupport } from "./types.ts";

export const CODEX_CONTEXT_WINDOW = 272_000;

export function codexReasoning(level: ThinkingLevel): ReasoningSupport {
	if (level === "minimal") {
		return { effective: "low", warning: "Reasoning minimal is not supported by codex exec; using low." };
	}
	return { effective: level };
}

export interface CodexFiles {
	instructions: string;
	schema?: string;
}

export function buildCodexArgs(ref: ModelRef, options: CallOptions, files: CodexFiles): string[] {
	const args = [
		"exec",
		"--json",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--skip-git-repo-check",
		"--sandbox", "read-only",
		"--model", ref.model,
		"-c", `model_instructions_file=${files.instructions}`,
	];
	if (options.reasoning) args.push("-c", `model_reasoning_effort=${options.reasoning}`);
	if (files.schema) args.push("--output-schema", files.schema);
	args.push("-");
	return args;
}

interface CodexEvent {
	type?: string;
	item?: { type?: string; text?: string; message?: string };
	error?: { message?: string };
}

function parseEvent(line: string): CodexEvent | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as CodexEvent) : undefined;
	} catch {
		return undefined;
	}
}

export function parseCodexOutput(stdout: string, stderr: string, exitCode: number | null, ref: ModelRef): CallResult {
	let text: string | undefined;
	let failure: string | undefined;
	const warnings: string[] = [];
	for (const line of stdout.split("\n")) {
		const event = parseEvent(line);
		if (!event) continue;
		if (event.type === "turn.failed") {
			failure = event.error?.message;
		} else if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
			text = event.item.text;
		} else if (event.type === "item.completed" && event.item?.type === "error" && event.item.message) {
			warnings.push(`${ref.display}: ${event.item.message}`);
		}
	}
	if (failure !== undefined || exitCode !== 0) {
		throw new Error(failure || stderr.trim() || `codex exec failed (exit ${exitCode ?? "null"})`);
	}
	if (text === undefined) {
		throw new Error(`codex exec produced no agent message: ${(stderr || stdout).trim().slice(0, 500)}`);
	}
	return { text, ...(warnings.length > 0 ? { warnings } : {}) };
}

async function runCodex(spawnImpl: SpawnLike, ref: ModelRef, options: CallOptions): Promise<CallResult> {
	const dir = await mkdtemp(join(tmpdir(), "claude-fusion-codex-"));
	try {
		const files: CodexFiles = { instructions: join(dir, "system.md") };
		await writeFile(files.instructions, options.systemPrompt);
		if (options.jsonSchema) {
			files.schema = join(dir, "schema.json");
			await writeFile(files.schema, JSON.stringify(options.jsonSchema));
		}
		return await runCli(
			spawnImpl,
			{ command: "codex", args: buildCodexArgs(ref, options, files), cwd: options.cwd, stdin: options.userText, signal: options.signal },
			(stdout, stderr, exitCode) => parseCodexOutput(stdout, stderr, exitCode, ref),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export function createCodexBackend(spawnImpl: SpawnLike = spawn): Backend {
	return {
		name: "codex",
		supportsTools: false,
		supportsReasoning(ref, level) {
			const support = codexReasoning(level);
			return support.warning
				? { effective: support.effective, warning: `Reasoning ${level} is not supported by ${ref.display}; using low.` }
				: support;
		},
		async contextWindow() {
			return CODEX_CONTEXT_WINDOW;
		},
		call(ref, options) {
			return runCodex(spawnImpl, ref, options);
		},
	};
}
