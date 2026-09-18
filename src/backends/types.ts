import type { ToolName } from "../tools.ts";
import type { BackendName, ModelRef, PanelToolUsage, ThinkingLevel } from "../types.ts";

export interface CallOptions {
	systemPrompt: string;
	userText: string;
	maxTokens: number;
	temperature: number;
	reasoning?: ThinkingLevel;
	tools: ToolName[];
	maxToolCalls: number;
	jsonSchema?: Record<string, unknown>;
	cwd: string;
	signal?: AbortSignal;
}

export interface CallResult {
	text: string;
	structured?: unknown;
	tools?: PanelToolUsage;
	warnings?: string[];
}

export interface ReasoningSupport {
	effective?: ThinkingLevel;
	warning?: string;
}

export interface Backend {
	name: BackendName;
	supportsTools: boolean;
	call(ref: ModelRef, options: CallOptions): Promise<CallResult>;
	contextWindow(ref: ModelRef): Promise<number>;
	supportsReasoning(ref: ModelRef, level: ThinkingLevel): ReasoningSupport;
}

export type Backends = Record<BackendName, Backend>;
