import { formatAnalysis, formatResult } from "../format.ts";
import type { FusionAnalysis, FusionDetails } from "../types.ts";
import { test } from "./_harness.ts";

test("formatAnalysis includes all sections", () => {
	const analysis: FusionAnalysis = {
		consensus: ["agreed"],
		contradictions: [{ topic: "t", stances: [{ model: "a/m", stance: "yes" }] }],
		partial_coverage: [{ models: ["a/m"], point: "p" }],
		unique_insights: [{ model: "a/m", insight: "i" }],
		blind_spots: ["missing"],
	};
	const text = formatAnalysis(analysis);
	for (const header of ["Consensus", "Contradictions", "Partial Coverage", "Unique Insights", "Blind Spots"]) {
		if (!text.includes(header)) throw new Error(`missing ${header}`);
	}
});

test("formatResult includes panel metadata, failures and raw responses", () => {
	const details: FusionDetails = {
		status: "ok",
		responses: [{ model: "claude/opus", content: "hello" }],
		failed_models: [{ model: "openrouter/x/y", error: "OpenRouter 429 (rate limited): slow down" }],
		panel_models: ["claude/opus", "openrouter/x/y"],
		judge_model: "claude/sonnet",
	};
	const result = formatResult(details);
	for (const needle of ["claude/opus", "claude/sonnet", "openrouter/x/y (OpenRouter 429", "### claude/opus\nhello", "Only one panel model"]) {
		if (!result.includes(needle)) throw new Error(`missing ${needle} in:\n${result}`);
	}
});
