import type { Backend, Backends, CallOptions, CallResult, ReasoningSupport } from "../backends/types.ts";
import type { BackendName, ModelRef, ThinkingLevel } from "../types.ts";

export type ScriptedResponse = CallResult | Error | ((options: CallOptions) => CallResult);

export interface RecordedCall {
	model: string;
	options: CallOptions;
}

export interface FakeBackend extends Backend {
	calls: RecordedCall[];
}

export function fakeBackend(
	name: BackendName,
	responses: Record<string, ScriptedResponse>,
	opts: { supportsTools?: boolean; reasoning?: (ref: ModelRef, level: ThinkingLevel) => ReasoningSupport; contextWindow?: number | Error } = {},
): FakeBackend {
	const calls: RecordedCall[] = [];
	return {
		name,
		calls,
		supportsTools: opts.supportsTools ?? false,
		supportsReasoning: opts.reasoning ?? ((_ref, level) => ({ effective: level })),
		async contextWindow() {
			if (opts.contextWindow instanceof Error) throw opts.contextWindow;
			return opts.contextWindow ?? 128_000;
		},
		async call(ref, options) {
			calls.push({ model: ref.model, options });
			const scripted = responses[ref.model];
			if (scripted === undefined) throw new Error(`no response scripted for ${ref.display}`);
			if (scripted instanceof Error) throw scripted;
			return typeof scripted === "function" ? scripted(options) : scripted;
		},
	};
}

export function fakeBackends(claude: FakeBackend, openrouter: FakeBackend): Backends {
	return { claude, openrouter };
}

export const EMPTY_ANALYSIS = JSON.stringify({ consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] });
