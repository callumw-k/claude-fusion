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
