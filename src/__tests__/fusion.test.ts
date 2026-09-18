import {
	compactFusionToolText,
	emptyPanelError,
	parseFusionAnalysis,
	resolveFusionSelection,
	resolvePanelReasoning,
	runFusion,
	type RunFusionInput,
} from "../fusion.ts";
import { parseModelRef } from "../backends/registry.ts";
import type { FusionConfig } from "../types.ts";
import { EMPTY_ANALYSIS, fakeBackend, fakeBackends } from "./_fake_backend.ts";
import { eq, test } from "./_harness.ts";

test("parseFusionAnalysis defaults missing arrays to empty", () => {
	eq(parseFusionAnalysis({ consensus: ["agreed"] }), {
		consensus: ["agreed"],
		contradictions: [],
		partial_coverage: [],
		unique_insights: [],
		blind_spots: [],
	}, "missing arrays default to []");
	eq(parseFusionAnalysis("not an object"), undefined, "non-object");
	eq(parseFusionAnalysis(undefined), undefined, "undefined");
	eq(parseFusionAnalysis({}), undefined, "empty object");
	eq(parseFusionAnalysis({ consensus: "string" }), undefined, "non-array key");
});

test("compactFusionToolText returns analysis plus excerpts, not full panel text", () => {
	const long = "PANEL-FULL-".repeat(80);
	const text = compactFusionToolText({
		status: "ok",
		analysis: { consensus: ["agreed"], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] },
		responses: [{ model: "claude/opus", content: long }],
		panel_models: ["claude/opus"],
		judge_model: "claude/sonnet",
	});
	if (!text.includes("agreed")) throw new Error("expected analysis");
	if (!text.includes("excerpts")) throw new Error("expected excerpts key");
	if (text.includes(long)) throw new Error("must not include full panel answer");
	if (!text.includes("…")) throw new Error("expected truncated excerpt");
});

test("compactFusionToolText passes through a lone unjudged panel response", () => {
	const long = "PANEL-FULL-".repeat(80);
	const text = compactFusionToolText({ status: "ok", responses: [{ model: "claude/opus", content: long }], panel_models: ["claude/opus"], judge_model: "claude/sonnet" });
	if (!text.includes(long)) throw new Error("single unjudged response must be returned in full");
});

test("emptyPanelError classifies blank output", () => {
	eq(emptyPanelError("a real answer", true), undefined, "non-empty");
	eq(emptyPanelError("   \n\t ", false), "empty response", "whitespace");
	eq(emptyPanelError("", true), "no text answer (tool-call budget or loop guard hit)", "capped + empty");
});

const twoBackendConfig: FusionConfig = {
	panels: { quality: { models: ["claude/opus", "openrouter/openai/gpt-5.5"], judge: "claude/sonnet", panelReasoning: "xhigh" } },
	defaultPanel: "quality",
	panelReasoning: "low",
	judgeReasoning: "medium",
};

test("resolveFusionSelection reports the named default and explicit profiles", () => {
	const byDefault = resolveFusionSelection(twoBackendConfig, {});
	if (!byDefault.ok) throw new Error(byDefault.result.details.error);
	eq(byDefault.resolution.profileName, "quality", "default profile");
	eq(byDefault.resolution.source, "default", "default source");
	eq(byDefault.config.panelReasoning, "xhigh", "named panel reasoning wins");
	eq(byDefault.config.judgeReasoning, "medium", "judge reasoning inherited");

	const explicit = resolveFusionSelection({ ...twoBackendConfig, defaultPanel: undefined }, { panel_profile: "quality" });
	if (!explicit.ok) throw new Error(explicit.result.details.error);
	eq(explicit.resolution.source, "explicit", "explicit source");
});

test("resolveFusionSelection fails closed for a bad explicit profile and for no panel at all", () => {
	const missing = resolveFusionSelection(twoBackendConfig, { panel_profile: "nope" });
	if (missing.ok) throw new Error("expected failure");
	eq(missing.result.details.status, "error", "error status");
	eq(missing.result.details.panel_profile, "nope", "names the panel");
	eq(missing.result.details.responses, [], "no responses");

	const empty = resolveFusionSelection({}, {});
	if (empty.ok) throw new Error("expected failure");
	if (!empty.result.details.error?.includes("No panel configured")) throw new Error(`unexpected: ${empty.result.details.error}`);
});

test("resolveFusionSelection falls back from an unresolvable default to the legacy panel with warnings", () => {
	const result = resolveFusionSelection({
		panel: ["claude/opus"],
		judge: "claude/sonnet",
		panels: { quality: { models: ["anthropic/opus"] } },
		defaultPanel: "quality",
	}, {});
	if (!result.ok) throw new Error(result.result.details.error);
	eq(result.resolution.panel.map((m) => m.display), ["claude/opus"], "legacy panel");
	eq(result.resolution.profileName, undefined, "failed default not reported");
	if (!result.resolution.warnings.some((w) => w.includes("quality"))) throw new Error(`missing warning: ${result.resolution.warnings.join("; ")}`);
});

test("resolvePanelReasoning records per-model support in panel order", () => {
	const claude = fakeBackend("claude", {}, { reasoning: (_ref, level) => (level === "minimal" ? { effective: "low", warning: "minimal downgraded" } : { effective: level }) });
	const openrouter = fakeBackend("openrouter", {});
	const plan = resolvePanelReasoning([parseModelRef("claude/opus")!, parseModelRef("openrouter/a/b")!], fakeBackends(claude, openrouter), "minimal");
	eq(plan.effective, { "claude/opus": "low", "openrouter/a/b": "minimal" }, "effective per model");
	eq(plan.warnings, ["minimal downgraded"], "warning collected");
	eq(resolvePanelReasoning([parseModelRef("claude/opus")!], fakeBackends(claude, openrouter), undefined).effective, { "claude/opus": null }, "no request means null");
});

function input(config: FusionConfig, backends: RunFusionInput["backends"], overrides: Partial<RunFusionInput> = {}): RunFusionInput {
	return { projectDir: "/tmp", config, backends, prompt: "compare", overrides: {}, consented: false, ...overrides };
}

test("runFusion runs the panel, prefers structured judge output and records reasoning diagnostics", async () => {
	const claude = fakeBackend("claude", {
		opus: { text: "claude answer that is long enough to be excerpted by the tool result text" },
		sonnet: { text: "ignored text", structured: { consensus: ["both agree"] } },
	}, { supportsTools: true });
	const openrouter = fakeBackend("openrouter", { "openai/gpt-5.5": { text: "openrouter answer that is long enough to be excerpted by the tool result" } });
	const progress: string[] = [];
	const result = await runFusion(input(twoBackendConfig, fakeBackends(claude, openrouter), { onProgress: (m) => progress.push(m) }));

	eq(result.details.status, "ok", "ok");
	eq(result.details.analysis?.consensus, ["both agree"], "structured judge output used");
	eq(result.details.responses.map((r) => r.model), ["claude/opus", "openrouter/openai/gpt-5.5"], "panel order kept");
	eq(result.details.judge_model, "claude/sonnet", "judge");
	eq(result.details.panel_profile, "quality", "profile");
	eq(result.details.panel_reasoning, { requested: "xhigh", effective: { "claude/opus": "xhigh", "openrouter/openai/gpt-5.5": "xhigh" } }, "panel reasoning");
	eq(result.details.judge_reasoning, { requested: "medium", effective: "medium" }, "judge reasoning");
	eq(claude.calls.map((c) => [c.model, c.options.reasoning, c.options.jsonSchema !== undefined]), [["opus", "xhigh", false], ["sonnet", "medium", true]], "claude calls: panel then judge with schema");
	eq(openrouter.calls[0].options.reasoning, "xhigh", "openrouter reasoning");
	if (!openrouter.calls[0].options.signal) throw new Error("expected a timeout signal on every call");
	eq(progress.length, 2, "resolving and judging progress");
	if (!result.content[0].text.includes("excerpts")) throw new Error("tool text uses excerpts");
});

test("runFusion skips the judge with a single success and passes the answer through", async () => {
	const claude = fakeBackend("claude", { opus: { text: "only answer" }, sonnet: new Error("should not be called") });
	const openrouter = fakeBackend("openrouter", { "openai/gpt-5.5": new Error("OpenRouter 429 (rate limited): slow down") });
	const result = await runFusion(input(twoBackendConfig, fakeBackends(claude, openrouter)));
	eq(result.details.status, "ok", "still ok");
	eq(result.details.analysis, undefined, "no analysis");
	eq(result.details.failed_models, [{ model: "openrouter/openai/gpt-5.5", error: "OpenRouter 429 (rate limited): slow down" }], "failure recorded");
	eq(claude.calls.map((c) => c.model), ["opus"], "judge never called");
	if (!result.content[0].text.includes("only answer")) throw new Error("single answer passes through");
});

test("runFusion surfaces an unparseable judge and classifies total failure", async () => {
	const claude = fakeBackend("claude", { opus: { text: "first answer, long enough to be excerpted in the tool result output" }, sonnet: { text: "the judge said words but not JSON" } });
	const openrouter = fakeBackend("openrouter", { "openai/gpt-5.5": { text: "second answer, long enough to be excerpted in the tool result output" } });
	const result = await runFusion(input(twoBackendConfig, fakeBackends(claude, openrouter)));
	eq(result.details.analysis, undefined, "no analysis");
	eq(result.details.failure_reason, "unexpected_error", "judge failure classified");
	if (!result.details.warnings?.some((w) => w.includes("unparseable"))) throw new Error("expected unparseable warning");

	const allFail = await runFusion(input(twoBackendConfig, fakeBackends(
		fakeBackend("claude", { opus: new Error("OpenRouter 402 (insufficient credits): nope") }),
		fakeBackend("openrouter", { "openai/gpt-5.5": new Error("OpenRouter 402 (insufficient credits): nope") }),
	)));
	eq(allFail.details.status, "error", "error status");
	eq(allFail.details.failure_reason, "insufficient_credits", "credits classified");
	eq(allFail.details.error, "all panel models failed", "error text");
});

test("runFusion strips mutating tools without consent, serialises with consent, and warns for toolless backends", async () => {
	const withTools: FusionConfig = { panel: ["claude/opus", "openrouter/a/b"], judge: "claude/sonnet", panelTools: "all", maxToolCalls: 4 };
	const claude = fakeBackend("claude", { opus: { text: "claude", structured: undefined }, sonnet: { text: EMPTY_ANALYSIS } }, { supportsTools: true });
	const openrouter = fakeBackend("openrouter", { "a/b": { text: "openrouter" } });

	const stripped = await runFusion(input(withTools, fakeBackends(claude, openrouter)));
	eq(claude.calls[0].options.tools, ["Read", "Grep", "Glob"], "readonly subset without consent");
	eq(openrouter.calls[0].options.tools, [], "openrouter never gets tools");
	eq(stripped.details.panel_tools, { mode: "Read,Grep,Glob", max_tool_calls: 4, serialized: false }, "diagnostics");
	if (!stripped.details.warnings?.some((w) => w.includes("consent"))) throw new Error("expected consent warning");
	if (!stripped.details.warnings?.some((w) => w.includes("openrouter/a/b runs without panel tools"))) throw new Error("expected toolless warning");

	claude.calls.length = 0;
	const consented = await runFusion(input({ ...withTools, panelToolsConsent: true }, fakeBackends(claude, openrouter)));
	eq(claude.calls[0].options.tools, ["Read", "Grep", "Glob", "Bash", "Edit", "Write"], "all tools with consent");
	eq(consented.details.panel_tools?.serialized, true, "mutating panel serialised");
	if (claude.calls[0].options.systemPrompt === claude.calls[1].options.systemPrompt) throw new Error("panel and judge prompts differ");
});

test("runFusion treats blank panel output as failure and honours the armed profile", async () => {
	const config: FusionConfig = {
		panel: ["claude/opus"],
		panels: { alt: { models: ["openrouter/a/b", "openrouter/c/d"], judge: "openrouter/a/b" } },
	};
	const claude = fakeBackend("claude", { opus: { text: "   " } });
	const openrouter = fakeBackend("openrouter", { "a/b": { text: "one answer, long enough to be excerpted" }, "c/d": { text: "two answer, long enough to be excerpted" } });
	const blank = await runFusion(input(config, fakeBackends(claude, openrouter)));
	eq(blank.details.status, "error", "blank is a failure");
	eq(blank.details.failed_models?.[0].error, "empty response", "empty response reason");

	openrouter.calls.length = 0;
	const armed = await runFusion(input(config, fakeBackends(claude, openrouter), { overrides: { panel_profile: "alt" } }));
	eq(armed.details.panel_profile, "alt", "armed profile used");
	eq(openrouter.calls.map((c) => c.model), ["a/b", "c/d", "a/b"], "two panelists then judge");
	eq(claude.calls.length, 1, "legacy panel not used for the armed run");
});
