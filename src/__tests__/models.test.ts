import { NO_PANEL_MESSAGE, PanelSelectionError, resolvePanelAndJudge } from "../models.ts";
import { modelDisplay } from "../backends/registry.ts";
import { eq, test } from "./_harness.ts";

function attempt(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

test("first candidate with valid ids wins, capped at maxPanelModels, deduped", () => {
	const result = resolvePanelAndJudge({
		candidates: [
			{ source: "default", profileName: "quality", panel: ["claude/opus", "claude/opus", "openrouter/a/b", "openrouter/c/d"], judge: "claude/sonnet", maxPanelModels: 2 },
			{ source: "legacy", panel: ["claude/haiku"], maxPanelModels: 3 },
		],
	});
	eq(result.panel.map(modelDisplay), ["claude/opus", "openrouter/a/b"], "deduped and capped");
	eq(modelDisplay(result.judge), "claude/sonnet", "judge resolved");
	eq(result.source, "default", "source");
	eq(result.profileName, "quality", "profile name");
	eq(result.warnings, [], "no warnings");
});

test("hard limit of 8 applies even when a candidate asks for more", () => {
	const panel = Array.from({ length: 10 }, (_, i) => `openrouter/v/m${i}`);
	const result = resolvePanelAndJudge({ candidates: [{ source: "legacy", panel, maxPanelModels: 20 }] });
	eq(result.panel.length, 8, "hard cap");
});

test("invalid ids warn and a candidate with none falls through to the next", () => {
	const result = resolvePanelAndJudge({
		warnings: ["earlier"],
		candidates: [
			{ source: "default", profileName: "quality", panel: ["anthropic/opus"], maxPanelModels: 3 },
			{ source: "legacy", panel: ["claude/opus"], maxPanelModels: 3 },
		],
	});
	eq(result.panel.map(modelDisplay), ["claude/opus"], "legacy wins");
	eq(result.source, "legacy", "legacy source");
	eq(result.profileName, undefined, "failed default not reported");
	eq(result.warnings, [
		"earlier",
		"Unknown model identifier: anthropic/opus",
		'Named panel "quality" contained no valid model identifiers. Trying the next configured candidate.',
	], "warning order");
});

test("strict candidate throws without consulting later candidates", () => {
	const error = attempt(() =>
		resolvePanelAndJudge({
			candidates: [
				{ source: "explicit", profileName: "quality", panel: ["bogus"], maxPanelModels: 3, strict: true },
				{ source: "legacy", panel: ["claude/opus"], maxPanelModels: 3 },
			],
		}),
	);
	if (!(error instanceof PanelSelectionError)) throw new Error("expected PanelSelectionError");
	eq(error.profileName, "quality", "names the panel");
	eq(error.message, 'Named panel "quality" contained no valid model identifiers.', "message");
	eq(error.warnings.length, 2, "carries warnings");
});

test("no candidates at all is a PanelSelectionError with the no-panel message", () => {
	const error = attempt(() => resolvePanelAndJudge({ candidates: [{ source: "legacy", panel: [], maxPanelModels: 3 }] }));
	if (!(error instanceof PanelSelectionError)) throw new Error("expected PanelSelectionError");
	eq(error.profileName, undefined, "no profile");
	eq(error.message, NO_PANEL_MESSAGE, "no-panel message");
});

test("missing or invalid judge falls back to the first panelist with a warning", () => {
	const noJudge = resolvePanelAndJudge({ candidates: [{ source: "legacy", panel: ["openrouter/a/b", "claude/opus"], maxPanelModels: 3 }] });
	eq(modelDisplay(noJudge.judge), "openrouter/a/b", "first panelist judges");
	eq(noJudge.warnings, [], "no warning when judge simply unset");

	const badJudge = resolvePanelAndJudge({ candidates: [{ source: "legacy", panel: ["claude/opus"], judge: "nope", maxPanelModels: 3 }] });
	eq(modelDisplay(badJudge.judge), "claude/opus", "fallback judge");
	eq(badJudge.warnings, ["Unknown judge identifier: nope"], "judge warning");
});
