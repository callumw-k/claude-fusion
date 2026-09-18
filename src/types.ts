export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type BackendName = "claude" | "codex" | "openrouter";

export interface ModelRef {
	backend: BackendName;
	model: string;
	display: string;
}

export type ToolMode = "none" | "readonly" | "all";
export type ToolSelection = ToolMode | string[];
export type FusionMode = "available" | "forced" | "off";

export interface NamedPanelConfig {
	models: string[];
	judge?: string;
	panelReasoning?: ThinkingLevel;
	judgeReasoning?: ThinkingLevel;
}

export interface FusionConfig {
	/** Explicit panel model identifiers, e.g. ["claude/opus", "openrouter/openai/gpt-5.5"]. */
	panel?: string[];
	judge?: string;
	panels?: Record<string, NamedPanelConfig>;
	defaultPanel?: string;
	panelReasoning?: ThinkingLevel;
	judgeReasoning?: ThinkingLevel;
	/** Max panel models (1–8). */
	maxPanelModels?: number;
	maxPanelOutputTokens?: number;
	maxCompletionTokens?: number;
	/** Sampling temperature; only OpenRouter models honour it. */
	temperature?: number;
	/** Panel tool access: "none" (default), "readonly", "all", or an explicit tool-name list. Claude panelists only. */
	panelTools?: ToolSelection;
	/** Max agentic turns per Claude panelist (1–100, default 16). */
	maxToolCalls?: number;
	/** Consent for mutating tools (Bash/Edit/Write). */
	panelToolsConsent?: boolean;
	/** Per model call timeout (default 600). */
	timeoutSeconds?: number;
}

export type ResolvedFusionConfig = FusionConfig & {
	maxPanelModels: number;
	maxPanelOutputTokens: number;
	maxCompletionTokens: number;
	temperature: number;
	maxToolCalls: number;
	timeoutSeconds: number;
};

export type ConfigSelectionSource = "explicit" | "default" | "legacy";
export type ConfigSelectionErrorCode = "unknown_named_panel" | "invalid_named_panel";

export interface ConfigSelectionError {
	code: ConfigSelectionErrorCode;
	panelName: string;
	message: string;
}

export type EffectiveConfigResult =
	| {
		ok: true;
		config: ResolvedFusionConfig;
		profileName?: string;
		source: ConfigSelectionSource;
		warnings: string[];
	}
	| {
		ok: false;
		error: ConfigSelectionError;
		warnings: string[];
	};

export interface PanelResult {
	model: string;
	content: string;
	error?: string;
	tools?: PanelToolUsage;
}

export interface FusionAnalysis {
	consensus: string[];
	contradictions: Array<{ topic: string; stances: Array<{ model: string; stance: string }> }>;
	partial_coverage: Array<{ models: string[]; point: string }>;
	unique_insights: Array<{ model: string; insight: string }>;
	blind_spots: string[];
}

export interface FusionOptions {
	/** Named panel armed by /fusion <name>. Never exposed on the tool schema. */
	panel_profile?: string;
}

export interface PanelToolUsage {
	turns: number;
	tool_calls: Array<{ name: string; ok: boolean }>;
	capped: boolean;
}

export interface FusionResult {
	content: Array<{ type: "text"; text: string }>;
	details: FusionDetails;
}

export interface FusionDetails {
	status: "ok" | "error";
	analysis?: FusionAnalysis;
	responses: Array<{ model: string; content: string; tools?: PanelToolUsage }>;
	failed_models?: Array<{ model: string; error: string; tools?: PanelToolUsage }>;
	panel_models?: string[];
	judge_model?: string;
	panel_profile?: string;
	panel_reasoning?: { requested: ThinkingLevel; effective: Record<string, ThinkingLevel | null> };
	judge_reasoning?: { requested: ThinkingLevel; effective: ThinkingLevel | null };
	panel_tools?: { mode: string; max_tool_calls: number; serialized: boolean };
	warnings?: string[];
	error?: string;
	failure_reason?: "all_panels_failed" | "insufficient_credits" | "rate_limited" | "unexpected_error";
}
