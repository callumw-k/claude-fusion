import { EventEmitter } from "node:events";
import { buildChildEnv, buildClaudeArgs, claudeReasoning, createClaudeBackend, parseClaudeOutput, type SpawnLike } from "../backends/claude.ts";
import type { CallOptions } from "../backends/types.ts";
import { parseModelRef } from "../backends/registry.ts";
import { eq, test } from "./_harness.ts";

const ref = parseModelRef("claude/opus")!;

interface FakeSpawn {
	spawn: SpawnLike;
	calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }>;
	kills: string[];
}

function fakeSpawn(stdout?: string): FakeSpawn {
	const record: FakeSpawn = { calls: [], kills: [], spawn: undefined as unknown as SpawnLike };
	record.spawn = ((_cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
		record.calls.push({ args: [...args], env: opts.env });
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { end(): void }; kill(signal: string): boolean };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = Object.assign(new EventEmitter(), { end() {} });
		child.kill = (signal: string) => {
			record.kills.push(signal);
			return true;
		};
		if (stdout !== undefined) {
			setImmediate(() => {
				child.stdout.emit("data", stdout);
				child.emit("close", 0);
			});
		}
		return child;
	}) as unknown as SpawnLike;
	return record;
}

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

test("the claude child never gets an output-token cap", async () => {
	const fake = fakeSpawn(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "pong" }));
	const result = await createClaudeBackend(fake.spawn).call(ref, options({ maxTokens: 300 }));
	eq(result.text, "pong", "call resolves");
	eq(fake.calls.length, 1, "one spawn");
	eq(fake.calls[0].env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined, "no CLAUDE_CODE_MAX_OUTPUT_TOKENS in the child env");
	eq(buildChildEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "300", PATH: "/bin" }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, "300", "an explicit user setting is left alone");
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
