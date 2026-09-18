import { modelDisplay } from "./backends/registry.ts";
import type { Backend, Backends, CallOptions, CallResult } from "./backends/types.ts";
import { PANEL_CONCURRENCY, resolveEffectiveConfig, type ResolvedFusionConfig } from "./config.ts";
import { PanelSelectionError, resolvePanelAndJudge, type ResolveCandidate, type ResolveResult } from "./models.ts";
import {
	FUSION_ANALYSIS_SCHEMA,
	JUDGE_SYSTEM_PROMPT,
	PANEL_SYSTEM_PROMPT,
	PANEL_SYSTEM_PROMPT_WITH_TOOLS,
	truncateForJudge,
} from "./prompts.ts";
import { clampMaxToolCalls, isMutatingSelection, MUTATING_TOOL_NAMES, selectionLabel, selectionToNames } from "./tools.ts";
import type {
	EffectiveConfigResult,
	FusionAnalysis,
	FusionConfig,
	FusionDetails,
	FusionOptions,
	FusionResult,
	ModelRef,
	PanelResult,
	ThinkingLevel,
	ToolSelection,
} from "./types.ts";
import { extractJson, mapWithConcurrencyLimit, truncateToBytes } from "./utils.ts";

const TOOL_RESULT_EXCERPT_BYTES = 480;

const ANALYSIS_KEYS = ["consensus", "contradictions", "partial_coverage", "unique_insights", "blind_spots"] as const;

export function parseFusionAnalysis(value: unknown): FusionAnalysis | undefined {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	if (!ANALYSIS_KEYS.some((key) => Array.isArray(obj[key]))) return undefined;
	return {
		consensus: Array.isArray(obj.consensus) ? obj.consensus : [],
		contradictions: Array.isArray(obj.contradictions) ? obj.contradictions : [],
		partial_coverage: Array.isArray(obj.partial_coverage) ? obj.partial_coverage : [],
		unique_insights: Array.isArray(obj.unique_insights) ? obj.unique_insights : [],
		blind_spots: Array.isArray(obj.blind_spots) ? obj.blind_spots : [],
	};
}

export function compactFusionToolText(details: FusionDetails): string {
	const passThroughSingle = details.responses.length === 1 && !details.analysis;
	return JSON.stringify(
		{
			status: details.status,
			analysis: details.analysis,
			excerpts: details.responses.map((r) => ({
				model: r.model,
				excerpt: passThroughSingle ? r.content : truncateToBytes(r.content, TOOL_RESULT_EXCERPT_BYTES, "…"),
				...(r.tools ? { tools: r.tools } : {}),
			})),
			...(details.failed_models ? { failed_models: details.failed_models } : {}),
			panel_models: details.panel_models,
			judge_model: details.judge_model,
			...(details.panel_profile ? { panel_profile: details.panel_profile } : {}),
			...(details.warnings ? { warnings: details.warnings } : {}),
			...(details.error ? { error: details.error } : {}),
			...(details.failure_reason ? { failure_reason: details.failure_reason } : {}),
		},
		null,
		2,
	);
}

function fusionToolResult(details: FusionDetails): FusionResult {
	return { content: [{ type: "text", text: compactFusionToolText(details) }], details };
}

export function disabledFusionResult(): FusionResult {
	return fusionToolResult({ status: "error", responses: [], error: "fusion disabled", failure_reason: "unexpected_error" });
}

export function emptyPanelError(content: string, capped: boolean): string | undefined {
	if (content.trim()) return undefined;
	return capped ? "no text answer (tool-call budget or loop guard hit)" : "empty response";
}

export interface PanelReasoningPlan {
	requested?: ThinkingLevel;
	effective: Record<string, ThinkingLevel | null>;
	warnings: string[];
}

export function resolvePanelReasoning(panel: ModelRef[], backends: Backends, requested: ThinkingLevel | undefined): PanelReasoningPlan {
	const effective: Record<string, ThinkingLevel | null> = {};
	const warnings: string[] = [];
	for (const ref of panel) {
		const name = modelDisplay(ref);
		if (!requested) {
			effective[name] = null;
			continue;
		}
		const support = backends[ref.backend].supportsReasoning(ref, requested);
		effective[name] = support.effective ?? null;
		if (support.warning) warnings.push(support.warning);
	}
	return { requested, effective, warnings };
}

export type FusionSelectionResult =
	| { ok: true; config: ResolvedFusionConfig; resolution: ResolveResult }
	| { ok: false; result: FusionResult };

export function resolveFusionSelection(rawConfig: FusionConfig, overrides: FusionOptions): FusionSelectionResult {
	const explicitProfile = overrides.panel_profile;
	const effective = resolveEffectiveConfig(rawConfig, explicitProfile);
	if (!effective.ok) {
		return selectionFailure(effective.error.message, effective.error.panelName, effective.warnings);
	}

	let legacyResult: EffectiveConfigResult = effective;
	if (effective.source === "default") {
		const legacyRaw = { ...rawConfig };
		delete legacyRaw.defaultPanel;
		legacyResult = resolveEffectiveConfig(legacyRaw);
	}
	if (!legacyResult.ok) {
		return selectionFailure(legacyResult.error.message, legacyResult.error.panelName, legacyResult.warnings);
	}
	const legacy = legacyResult;

	const candidates: ResolveCandidate[] = [];
	if (explicitProfile) {
		candidates.push({
			source: "explicit",
			profileName: effective.profileName,
			panel: effective.config.panel ?? [],
			judge: effective.config.judge,
			maxPanelModels: effective.config.maxPanelModels,
			strict: true,
		});
	} else {
		if (effective.source === "default") {
			candidates.push({
				source: "default",
				profileName: effective.profileName,
				panel: effective.config.panel ?? [],
				judge: effective.config.judge,
				maxPanelModels: effective.config.maxPanelModels,
			});
		}
		if (legacy.config.panel?.length) {
			candidates.push({
				source: "legacy",
				panel: legacy.config.panel,
				judge: legacy.config.judge,
				maxPanelModels: legacy.config.maxPanelModels,
			});
		}
	}

	try {
		const resolution = resolvePanelAndJudge({ candidates, warnings: effective.warnings });
		const config = resolution.source === "explicit" || resolution.source === "default" ? effective.config : legacy.config;
		return { ok: true, config, resolution };
	} catch (error) {
		if (error instanceof PanelSelectionError) {
			return selectionFailure(error.message, error.profileName, error.warnings);
		}
		throw error;
	}
}

function selectionFailure(message: string, profileName: string | undefined, warnings: string[]): FusionSelectionResult {
	const details: FusionDetails = {
		status: "error",
		responses: [],
		...(profileName ? { panel_profile: profileName } : {}),
		...(warnings.length ? { warnings } : {}),
		error: message,
		failure_reason: "unexpected_error",
	};
	return { ok: false, result: fusionToolResult(details) };
}

export type FusionPhase = "resolving" | "judging" | "single_response";

export interface RunFusionInput {
	projectDir: string;
	config: FusionConfig;
	backends: Backends;
	prompt: string;
	overrides: FusionOptions;
	consented: boolean;
	signal?: AbortSignal;
	onProgress?: (message: string, phase: FusionPhase) => void;
}

async function callWithTimeout(
	backend: Backend,
	ref: ModelRef,
	options: Omit<CallOptions, "signal">,
	timeoutSeconds: number,
	signal: AbortSignal | undefined,
): Promise<CallResult> {
	const signals = [AbortSignal.timeout(timeoutSeconds * 1000)];
	if (signal) signals.push(signal);
	return backend.call(ref, { ...options, signal: AbortSignal.any(signals) });
}

export async function runFusion(input: RunFusionInput): Promise<FusionResult> {
	const { backends, prompt, signal } = input;
	const selection = resolveFusionSelection(input.config, input.overrides);
	if (!selection.ok) return selection.result;
	const { config, resolution } = selection;
	const { panel, judge, warnings, profileName } = resolution;

	const panelReasoning = resolvePanelReasoning(panel, backends, config.panelReasoning);
	warnings.push(...panelReasoning.warnings);
	const panelReasoningDetails = panelReasoning.requested
		? { requested: panelReasoning.requested, effective: panelReasoning.effective }
		: undefined;

	let toolSelection: ToolSelection | undefined = config.panelTools;
	const hasConsent = input.consented || config.panelToolsConsent === true;
	if (isMutatingSelection(toolSelection) && !hasConsent) {
		const readOnly = selectionToNames(toolSelection).filter((n) => !MUTATING_TOOL_NAMES.includes(n));
		toolSelection = readOnly.length ? readOnly : "none";
		warnings.push("Mutating panel tools require consent (set panelToolsConsent in fusion.json); using read-only subset.");
	}
	const toolNames = selectionToNames(toolSelection);
	const toolsRequested = toolNames.length > 0;
	const maxToolCalls = clampMaxToolCalls(config.maxToolCalls);
	const mutating = isMutatingSelection(toolSelection);
	const panelConcurrency = mutating ? 1 : PANEL_CONCURRENCY;
	if (toolsRequested) {
		for (const ref of panel) {
			if (!backends[ref.backend].supportsTools) {
				warnings.push(`${modelDisplay(ref)} runs without panel tools (${ref.backend} backend has no tools).`);
			}
		}
	}

	const panelModelNames = panel.map(modelDisplay);
	const judgeName = modelDisplay(judge);
	const toolsLabel = toolsRequested ? ` | tools: ${selectionLabel(toolSelection)}·${maxToolCalls}${mutating ? " (serialized)" : ""}` : "";
	const panelReasoningLabel = panelReasoningDetails
		? ` | panel reasoning: ${panelReasoningDetails.requested} (${Object.entries(panelReasoningDetails.effective).map(([name, level]) => `${name}=${level ?? "off"}`).join(", ")})`
		: "";
	const judgeReasoningLabel = config.judgeReasoning ? ` | judge reasoning requested: ${config.judgeReasoning}` : "";

	input.onProgress?.(
		`Fusion panel: ${panelModelNames.join(", ")} | judge: ${judgeName}${profileName ? ` | named panel: ${profileName}` : ""}${panelReasoningLabel}${judgeReasoningLabel}${toolsLabel}${warnings.length > 0 ? " | warnings: " + warnings.join("; ") : ""}`,
		"resolving",
	);

	const rawPanelResults = await mapWithConcurrencyLimit(panel, panelConcurrency, async (ref): Promise<PanelResult> => {
		const base = { model: modelDisplay(ref) };
		const backend = backends[ref.backend];
		const effectiveReasoning = panelReasoning.effective[base.model] ?? undefined;
		const tools = backend.supportsTools ? toolNames : [];
		try {
			const result = await callWithTimeout(
				backend,
				ref,
				{
					systemPrompt: tools.length ? PANEL_SYSTEM_PROMPT_WITH_TOOLS : PANEL_SYSTEM_PROMPT,
					userText: prompt,
					maxTokens: config.maxPanelOutputTokens,
					temperature: config.temperature,
					reasoning: effectiveReasoning,
					tools,
					maxToolCalls,
					cwd: input.projectDir,
				},
				config.timeoutSeconds,
				signal,
			);
			if (result.warnings) warnings.push(...result.warnings);
			const error = emptyPanelError(result.text, result.tools?.capped ?? false);
			return { ...base, content: error ? "" : result.text, ...(error ? { error } : {}), ...(result.tools ? { tools: result.tools } : {}) };
		} catch (err) {
			return { ...base, content: "", error: err instanceof Error ? err.message : String(err) };
		}
	});

	const successful = rawPanelResults.filter((r): r is PanelResult & { error: undefined } => !r.error);
	const failed = rawPanelResults.filter((r): r is PanelResult & { error: string } => !!r.error);
	const failedDetails = failed.map((f) => ({ model: f.model, error: f.error, ...(f.tools ? { tools: f.tools } : {}) }));

	if (successful.length === 0) {
		return fusionToolResult({
			status: "error",
			responses: [],
			failed_models: failedDetails,
			panel_models: panelModelNames,
			judge_model: judgeName,
			...(profileName ? { panel_profile: profileName } : {}),
			...(panelReasoningDetails ? { panel_reasoning: panelReasoningDetails } : {}),
			...(warnings.length > 0 ? { warnings } : {}),
			error: "all panel models failed",
			failure_reason: classifyAllPanelFailure(failed),
		});
	}

	input.onProgress?.(
		successful.length === 1
			? `Panel complete (${successful.length}/${panel.length}). Only one model succeeded; skipping judge synthesis.`
			: `Panel complete (${successful.length}/${panel.length}). Running judge...`,
		successful.length === 1 ? "single_response" : "judging",
	);

	let analysis: FusionAnalysis | undefined;
	let judgeFailureReason: FusionDetails["failure_reason"];
	let judgeReasoningDetails: FusionDetails["judge_reasoning"];
	if (successful.length >= 2) {
		const judgeBackend = backends[judge.backend];
		const judgeReasoning = config.judgeReasoning ? judgeBackend.supportsReasoning(judge, config.judgeReasoning) : {};
		if (judgeReasoning.warning) warnings.push(judgeReasoning.warning);
		if (config.judgeReasoning) {
			judgeReasoningDetails = { requested: config.judgeReasoning, effective: judgeReasoning.effective ?? null };
		}
		try {
			const judgeBudgetPerResponse = Math.max(
				1024,
				Math.floor((await judgeBackend.contextWindow(judge)) / Math.max(successful.length * 2, 8)),
			);
			const judgeUserText =
				`Task:\n${prompt}\n\n` +
				successful.map((r) => `--- Response from ${r.model} ---\n${truncateForJudge(r.content, judgeBudgetPerResponse)}`).join("\n\n");
			const judgeResult = await callWithTimeout(
				judgeBackend,
				judge,
				{
					systemPrompt: JUDGE_SYSTEM_PROMPT,
					userText: judgeUserText,
					maxTokens: config.maxCompletionTokens,
					temperature: config.temperature,
					reasoning: judgeReasoning.effective,
					tools: [],
					maxToolCalls,
					jsonSchema: FUSION_ANALYSIS_SCHEMA,
					cwd: input.projectDir,
				},
				config.timeoutSeconds,
				signal,
			);
			if (judgeResult.warnings) warnings.push(...judgeResult.warnings);
			analysis = parseFusionAnalysis(judgeResult.structured ?? extractJson(judgeResult.text));
			if (!analysis) {
				warnings.push("Judge returned unparseable JSON; analysis is unavailable. Use /fusion-report for raw panel text.");
				judgeFailureReason = "unexpected_error";
			}
		} catch (err) {
			console.error("[claude-fusion] judge failed:", err);
			warnings.push("Judge call failed; analysis is unavailable. Use /fusion-report for raw panel text.");
			judgeFailureReason = "unexpected_error";
		}
	}

	return fusionToolResult({
		status: "ok",
		analysis,
		responses: successful.map((r) => ({ model: r.model, content: r.content, ...(r.tools ? { tools: r.tools } : {}) })),
		...(failed.length > 0 ? { failed_models: failedDetails } : {}),
		panel_models: panelModelNames,
		judge_model: judgeName,
		...(profileName ? { panel_profile: profileName } : {}),
		...(panelReasoningDetails ? { panel_reasoning: panelReasoningDetails } : {}),
		...(judgeReasoningDetails ? { judge_reasoning: judgeReasoningDetails } : {}),
		...(toolsRequested ? { panel_tools: { mode: selectionLabel(toolSelection), max_tool_calls: maxToolCalls, serialized: mutating } } : {}),
		...(warnings.length > 0 ? { warnings } : {}),
		...(judgeFailureReason ? { failure_reason: judgeFailureReason } : {}),
	});
}

function classifyAllPanelFailure(failed: PanelResult[]): FusionDetails["failure_reason"] {
	const messages = failed.map((f) => (f.error ?? "").toLowerCase());
	if (messages.some((m) => m.includes("credit") || m.includes("quota") || m.includes("billing"))) {
		return "insufficient_credits";
	}
	if (messages.some((m) => m.includes("rate limit") || m.includes("429"))) {
		return "rate_limited";
	}
	return "all_panels_failed";
}
