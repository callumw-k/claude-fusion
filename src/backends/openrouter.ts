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
