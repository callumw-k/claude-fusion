import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRef, ThinkingLevel } from "../types.ts";
import { runCli, type SpawnLike } from "./spawn.ts";
import type { Backend, CallOptions, CallResult, ReasoningSupport } from "./types.ts";

export const AGY_CONTEXT_WINDOW = 200_000;

const AGY_EFFORTS: readonly ThinkingLevel[] = ["low", "medium", "high"];
const EFFORT_SUFFIX = /-(low|medium|high)$/;

export function agyReasoning(ref: ModelRef, level: ThinkingLevel): ReasoningSupport {
	if (EFFORT_SUFFIX.test(ref.model)) {
		return { warning: `Reasoning ${level} is ignored for ${ref.display}; the model id fixes the effort.` };
	}
	if (AGY_EFFORTS.includes(level)) return { effective: level };
	const effective: ThinkingLevel = level === "minimal" ? "low" : "high";
	return { effective, warning: `Reasoning ${level} is not supported by ${ref.display}; using ${effective}.` };
}

export interface AgyFiles {
	schema?: string;
}

export function buildAgyArgs(ref: ModelRef, options: CallOptions, files: AgyFiles): string[] {
	const args = [
		"-p=",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--disable-slash-commands",
		"--sandbox",
		"--model", ref.model,
	];
	if (options.reasoning) args.push("--effort", options.reasoning);
	if (files.schema) args.push("--json-schema", files.schema);
	return args;
}

export function buildAgyStdin(options: CallOptions): string {
	const content = `${options.systemPrompt}\n\n---\n\n${options.userText}`;
	return JSON.stringify({ event: "user", message: { role: "user", content } }) + "\n";
}

interface AgyEvent {
	event?: string;
	result?: { status?: string; response?: string; structured_output?: unknown; error?: string };
}

function parseEvent(line: string): AgyEvent | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as AgyEvent) : undefined;
	} catch {
		return undefined;
	}
}

export function parseAgyOutput(stdout: string, stderr: string, exitCode: number | null, ref: ModelRef): CallResult {
	let result: AgyEvent["result"];
	for (const line of stdout.split("\n")) {
		const event = parseEvent(line);
		if (event?.event === "result" && event.result) result = event.result;
	}
	if ((result !== undefined && result.status !== "SUCCESS") || exitCode !== 0) {
		throw new Error(result?.error || stderr.trim() || `agy failed (exit ${exitCode ?? "null"})`);
	}
	if (result === undefined) {
		throw new Error(`agy produced no result for ${ref.display}: ${(stderr || stdout).trim().slice(0, 500)}`);
	}
	if (result.structured_output !== undefined) {
		return { text: JSON.stringify(result.structured_output), structured: result.structured_output };
	}
	return { text: result.response ?? "" };
}

async function runAgy(spawnImpl: SpawnLike, ref: ModelRef, options: CallOptions): Promise<CallResult> {
	const files: AgyFiles = {};
	const dir = options.jsonSchema ? await mkdtemp(join(tmpdir(), "claude-fusion-agy-")) : undefined;
	try {
		if (dir) {
			files.schema = join(dir, "schema.json");
			await writeFile(files.schema, JSON.stringify(options.jsonSchema));
		}
		return await runCli(
			spawnImpl,
			{ command: "agy", args: buildAgyArgs(ref, options, files), cwd: options.cwd, stdin: buildAgyStdin(options), signal: options.signal },
			(stdout, stderr, exitCode) => parseAgyOutput(stdout, stderr, exitCode, ref),
		);
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
}

export function createAgyBackend(spawnImpl: SpawnLike = spawn): Backend {
	return {
		name: "agy",
		supportsTools: false,
		supportsReasoning(ref, level) {
			return agyReasoning(ref, level);
		},
		async contextWindow() {
			return AGY_CONTEXT_WINDOW;
		},
		call(ref, options) {
			return runAgy(spawnImpl, ref, options);
		},
	};
}
