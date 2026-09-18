import { existsSync, readFileSync } from "node:fs";
import { buildCodexArgs, codexReasoning, createCodexBackend, parseCodexOutput } from "../backends/codex.ts";
import type { CallOptions } from "../backends/types.ts";
import { parseModelRef } from "../backends/registry.ts";
import { fakeSpawn } from "./_fake_spawn.ts";
import { eq, test } from "./_harness.ts";

const ref = parseModelRef("codex/gpt-5.5")!;

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

function events(list: unknown[]): string {
	return list.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

const pong = events([
	{ type: "thread.started", thread_id: "t1" },
	{ type: "turn.started" },
	{ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "pong" } },
	{ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } },
]);

test("buildCodexArgs runs exec headless with user config, rules and sessions off", () => {
	eq(buildCodexArgs(ref, options(), { instructions: "/tmp/x/system.md" }), [
		"exec",
		"--json",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--skip-git-repo-check",
		"--sandbox", "read-only",
		"--model", "gpt-5.5",
		"-c", "model_instructions_file=/tmp/x/system.md",
		"-",
	], "no reasoning, no schema");
});

test("buildCodexArgs adds reasoning effort and the schema file only when requested", () => {
	const args = buildCodexArgs(ref, options({ reasoning: "high" }), { instructions: "/tmp/x/system.md", schema: "/tmp/x/schema.json" });
	const joined = args.join(" ");
	for (const needle of ["-c model_reasoning_effort=high", "--output-schema /tmp/x/schema.json"]) {
		if (!joined.includes(needle)) throw new Error(`missing ${needle} in ${joined}`);
	}
});

test("codexReasoning maps minimal to low with a warning and passes the rest through", () => {
	eq(codexReasoning("minimal"), { effective: "low", warning: "Reasoning minimal is not supported by codex exec; using low." }, "minimal");
	for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
		eq(codexReasoning(level), { effective: level }, level);
	}
	const backend = createCodexBackend();
	eq(backend.supportsReasoning(ref, "minimal").warning, "Reasoning minimal is not supported by codex/gpt-5.5; using low.", "backend names the model");
	eq(backend.supportsTools, false, "codex panelists are text-only");
});

test("parseCodexOutput takes the last agent message", () => {
	eq(parseCodexOutput(pong, "", 0, ref), { text: "pong" }, "plain text");
	const twoMessages = events([
		{ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "thinking aloud" } },
		{ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "ls" } },
		{ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "final" } },
		{ type: "turn.completed", usage: {} },
	]);
	eq(parseCodexOutput(twoMessages, "", 0, ref).text, "final", "last message wins");
});

test("parseCodexOutput passes non-fatal error items through as warnings", () => {
	const noisy = events([
		{ type: "item.completed", item: { id: "item_0", type: "error", message: "Model metadata not found; using fallback." } },
		{ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "pong" } },
		{ type: "turn.completed", usage: {} },
	]);
	eq(parseCodexOutput(noisy, "", 0, ref), { text: "pong", warnings: ["codex/gpt-5.5: Model metadata not found; using fallback."] }, "warning carries the model");
});

test("parseCodexOutput throws the turn failure, then stderr, then a generic message", () => {
	const failed = events([
		{ type: "turn.started" },
		{ type: "error", message: "The model is not supported" },
		{ type: "turn.failed", error: { message: "The model is not supported" } },
	]);
	eq((attempt(() => parseCodexOutput(failed, "", 1, ref)) as Error).message, "The model is not supported", "turn.failed message");
	eq((attempt(() => parseCodexOutput("", "not logged in", 1, ref)) as Error).message, "not logged in", "stderr fallback");
	const silent = attempt(() => parseCodexOutput(events([{ type: "turn.completed", usage: {} }]), "", 0, ref)) as Error;
	if (!silent.message.includes("no agent message")) throw new Error(`unexpected: ${silent.message}`);
	const nonZero = attempt(() => parseCodexOutput(pong, "", 1, ref)) as Error;
	if (!nonZero.message.includes("exit 1")) throw new Error(`unexpected: ${nonZero.message}`);
});

test("the codex call writes the system prompt and schema to files, pipes the prompt, and removes the files", async () => {
	let instructionsPath = "";
	let schemaPath = "";
	let instructionsAtSpawn = "";
	let schemaAtSpawn = "";
	const fake = fakeSpawn({
		stdout: pong,
		onSpawn(args) {
			instructionsPath = args[args.indexOf("-c") + 1].replace("model_instructions_file=", "");
			schemaPath = args[args.indexOf("--output-schema") + 1];
			instructionsAtSpawn = readFileSync(instructionsPath, "utf8");
			schemaAtSpawn = readFileSync(schemaPath, "utf8");
		},
	});
	const result = await createCodexBackend(fake.spawn).call(ref, options({ jsonSchema: { type: "object" } }));
	eq(result.text, "pong", "call resolves");
	eq(fake.calls[0].command, "codex", "spawns codex");
	eq(fake.calls[0].stdin, "hello", "prompt goes on stdin");
	eq(instructionsAtSpawn, "SYS", "system prompt file holds the system prompt");
	eq(schemaAtSpawn, '{"type":"object"}', "schema file holds the schema");
	eq(existsSync(instructionsPath) || existsSync(schemaPath), false, "temp files are removed after the call");
});

test("a failed codex call still removes its temp files", async () => {
	let instructionsPath = "";
	const fake = fakeSpawn({
		stderr: "boom",
		code: 1,
		onSpawn(args) {
			instructionsPath = args[args.indexOf("-c") + 1].replace("model_instructions_file=", "");
		},
	});
	const error = await createCodexBackend(fake.spawn).call(ref, options()).then(() => undefined, (err: Error) => err);
	eq(error?.message, "boom", "failure surfaces stderr");
	eq(existsSync(instructionsPath), false, "temp file removed on failure");
});
