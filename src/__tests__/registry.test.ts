import { modelDisplay, parseModelRef, sameRef } from "../backends/registry.ts";
import { eq, test } from "./_harness.ts";

test("parseModelRef splits backend from model and keeps nested slashes", () => {
	eq(parseModelRef("claude/opus"), { backend: "claude", model: "opus", display: "claude/opus" }, "claude alias");
	eq(
		parseModelRef(" openrouter/openai/gpt-5.5 "),
		{ backend: "openrouter", model: "openai/gpt-5.5", display: "openrouter/openai/gpt-5.5" },
		"openrouter vendor/model, trimmed",
	);
	eq(parseModelRef("codex/gpt-5.5"), { backend: "codex", model: "gpt-5.5", display: "codex/gpt-5.5" }, "codex cli model");
	eq(parseModelRef("agy/gemini-3.8-flash"), { backend: "agy", model: "gemini-3.8-flash", display: "agy/gemini-3.8-flash" }, "antigravity cli model");
});

test("parseModelRef rejects unknown backends and empty parts", () => {
	for (const bad of ["anthropic/claude-opus-4-5", "claude/", "/opus", "opus", "", "CLAUDE/opus"]) {
		eq(parseModelRef(bad), undefined, `rejects ${JSON.stringify(bad)}`);
	}
});

test("modelDisplay and sameRef use the canonical display string", () => {
	const a = parseModelRef("claude/opus")!;
	const b = parseModelRef("claude/opus ")!;
	eq(modelDisplay(a), "claude/opus", "display");
	eq(sameRef(a, b), true, "same after trim");
	eq(sameRef(a, parseModelRef("claude/sonnet")!), false, "different model");
});
