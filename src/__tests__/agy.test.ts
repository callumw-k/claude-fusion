import { existsSync, readFileSync } from "node:fs";
import { agyReasoning, buildAgyArgs, buildAgyStdin, createAgyBackend, parseAgyOutput } from "../backends/agy.ts";
import type { CallOptions } from "../backends/types.ts";
import { parseModelRef } from "../backends/registry.ts";
import { fakeSpawn } from "./_fake_spawn.ts";
import { eq, test } from "./_harness.ts";

const ref = parseModelRef("agy/gemini-3.8-flash")!;

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
	{ event: "init", conversation_id: "c1", init: { cwd: "/tmp", tools: [] } },
	{ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } },
	{ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "pong" } },
	{ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "pong\n", num_turns: 1 } },
]);

test("buildAgyArgs runs print mode headless over stream-json with skills off", () => {
	eq(buildAgyArgs(ref, options(), {}), [
		"-p=",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--disable-slash-commands",
		"--sandbox",
		"--model", "gemini-3.8-flash",
	], "no reasoning, no schema");
});

test("buildAgyArgs adds effort and the schema file only when requested", () => {
	const args = buildAgyArgs(ref, options({ reasoning: "high" }), { schema: "/tmp/x/schema.json" });
	const joined = args.join(" ");
	for (const needle of ["--effort high", "--json-schema /tmp/x/schema.json"]) {
		if (!joined.includes(needle)) throw new Error(`missing ${needle} in ${joined}`);
	}
});

test("buildAgyStdin folds the system prompt into one user event", () => {
	eq(JSON.parse(buildAgyStdin(options())), {
		event: "user",
		message: { role: "user", content: "SYS\n\n---\n\nhello" },
	}, "user event");
	eq(buildAgyStdin(options()).endsWith("\n"), true, "one NDJSON line");
});

test("agyReasoning clamps to the CLI's low/medium/high and warns", () => {
	eq(agyReasoning(ref, "minimal"), { effective: "low", warning: "Reasoning minimal is not supported by agy/gemini-3.8-flash; using low." }, "minimal");
	eq(agyReasoning(ref, "xhigh"), { effective: "high", warning: "Reasoning xhigh is not supported by agy/gemini-3.8-flash; using high." }, "xhigh");
	eq(agyReasoning(ref, "max"), { effective: "high", warning: "Reasoning max is not supported by agy/gemini-3.8-flash; using high." }, "max");
	for (const level of ["low", "medium", "high"] as const) {
		eq(agyReasoning(ref, level), { effective: level }, level);
	}
});

test("agyReasoning leaves the effort to a model id that already carries one", () => {
	const fixed = parseModelRef("agy/gemini-3.1-pro-high")!;
	eq(agyReasoning(fixed, "medium"), { warning: "Reasoning medium is ignored for agy/gemini-3.1-pro-high; the model id fixes the effort." }, "suffixed id");
	const backend = createAgyBackend();
	eq(backend.supportsReasoning(fixed, "medium").effective, undefined, "no effort reaches the CLI");
	eq(backend.supportsTools, false, "agy panelists are text-only");
});

test("parseAgyOutput takes the response from the result event", () => {
	eq(parseAgyOutput(pong, "", 0, ref), { text: "pong\n" }, "plain text");
});

test("parseAgyOutput prefers structured output when the CLI enforced a schema", () => {
	const structured = events([
		{ event: "result", result: { status: "SUCCESS", response: '{"a":1,"toolAction":"Finishing task"}\n', structured_output: { a: 1 } } },
	]);
	eq(parseAgyOutput(structured, "", 0, ref), { text: '{"a":1}', structured: { a: 1 } }, "structured wins over the noisy response text");
});

test("parseAgyOutput throws the result error, then stderr, then a generic message", () => {
	const failed = events([
		{ event: "result", result: { status: "ERROR", response: "", error: "invalid model selection" } },
	]);
	eq((attempt(() => parseAgyOutput(failed, "error: invalid model selection", 1, ref)) as Error).message, "invalid model selection", "result error");
	eq((attempt(() => parseAgyOutput("", "not logged in", 1, ref)) as Error).message, "not logged in", "stderr fallback");
	const nonZero = attempt(() => parseAgyOutput("", "", 1, ref)) as Error;
	if (!nonZero.message.includes("exit 1")) throw new Error(`unexpected: ${nonZero.message}`);
	const silent = attempt(() => parseAgyOutput(events([{ event: "init", init: {} }]), "", 0, ref)) as Error;
	if (!silent.message.includes("no result")) throw new Error(`unexpected: ${silent.message}`);
});

test("the agy call writes the schema to a file, pipes the prompt, and removes the file", async () => {
	let schemaPath = "";
	let schemaAtSpawn = "";
	const fake = fakeSpawn({
		stdout: pong,
		onSpawn(args) {
			schemaPath = args[args.indexOf("--json-schema") + 1];
			schemaAtSpawn = readFileSync(schemaPath, "utf8");
		},
	});
	const result = await createAgyBackend(fake.spawn).call(ref, options({ jsonSchema: { type: "object" } }));
	eq(result.text, "pong\n", "call resolves");
	eq(fake.calls[0].command, "agy", "spawns agy");
	eq(JSON.parse(fake.calls[0].stdin).message.content, "SYS\n\n---\n\nhello", "prompt goes on stdin");
	eq(schemaAtSpawn, '{"type":"object"}', "schema file holds the schema");
	eq(existsSync(schemaPath), false, "temp file is removed after the call");
});

test("a failed agy call still removes its temp files", async () => {
	let schemaPath = "";
	const fake = fakeSpawn({
		stderr: "boom",
		code: 1,
		onSpawn(args) {
			schemaPath = args[args.indexOf("--json-schema") + 1];
		},
	});
	const error = await createAgyBackend(fake.spawn).call(ref, options({ jsonSchema: { type: "object" } })).then(() => undefined, (err: Error) => err);
	eq(error?.message, "boom", "failure surfaces stderr");
	eq(existsSync(schemaPath), false, "temp file removed on failure");
});
