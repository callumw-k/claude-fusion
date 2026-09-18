import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FORCE_PREAMBLE,
	forceFusionPrompt,
	fusionCommand,
	initCommand,
	parseModeWord,
	preToolUseHook,
	statusText,
	userPromptSubmitHook,
	type CommandContext,
} from "../cli.ts";
import type { SessionState } from "../state.ts";
import type { FusionConfig } from "../types.ts";
import { eq, test } from "./_harness.ts";

const config: FusionConfig = {
	panels: { quality: { models: ["claude/opus", "openrouter/a/b"], judge: "claude/sonnet" }, broken: { models: ["nope"] } },
	defaultPanel: "quality",
	panelTools: "readonly",
};

function ctx(state: SessionState, cfg: FusionConfig = config): CommandContext & { writes: Array<Partial<SessionState>> } {
	const writes: Array<Partial<SessionState>> = [];
	return { state, config: cfg, writes, setState: (patch) => writes.push(patch) };
}

test("parseModeWord accepts the pi-fusion aliases", () => {
	eq(parseModeWord("ON"), "forced", "on");
	eq(parseModeWord("force"), "forced", "force");
	eq(parseModeWord("auto"), "available", "auto");
	eq(parseModeWord("disabled"), "off", "disabled");
	eq(parseModeWord("hello"), undefined, "not a mode");
});

test("forceFusionPrompt wraps once and is idempotent", () => {
	const forced = forceFusionPrompt("what is x?");
	if (!forced.startsWith(FORCE_PREAMBLE)) throw new Error("missing preamble");
	if (!forced.endsWith("\n\nwhat is x?")) throw new Error("prompt not appended");
	if (forced.includes("context_mode")) throw new Error("pi-only instruction leaked");
	eq(forceFusionPrompt(forced), forced, "idempotent");
});

test("/fusion with no args toggles available and forced, requiring a panel for forced", () => {
	const on = ctx({ mode: "available" });
	eq(fusionCommand("", on), "Fusion mode is now forced. Tell the user.", "toggle on");
	eq(on.writes, [{ mode: "forced", armedPanel: undefined }], "state written");
	const off = ctx({ mode: "forced" });
	eq(fusionCommand("  ", off), "Fusion mode is now available. Tell the user.", "toggle back");
	const noPanel = ctx({ mode: "available" }, {});
	if (!fusionCommand("", noPanel).startsWith("Cannot enable forced mode: No panel configured")) throw new Error("expected panel error");
	eq(noPanel.writes, [], "nothing written");
	const explicitOff = ctx({ mode: "available" }, {});
	eq(fusionCommand("off", explicitOff), "Fusion mode is now off. Tell the user.", "off never needs a panel");
});

test("/fusion <name> arms a valid named panel and rejects a broken one", () => {
	const good = ctx({ mode: "available" });
	eq(fusionCommand("quality", good), 'Named panel "quality" armed for the next fusion call. Tell the user.', "armed");
	eq(good.writes, [{ armedPanel: "quality" }], "armed written");
	const bad = ctx({ mode: "available" });
	if (!fusionCommand("broken", bad).startsWith('Named panel "broken" cannot be used:')) throw new Error("expected rejection");
	eq(bad.writes, [], "nothing written");
});

test("/fusion <prompt> instructs a one-shot run unless fusion is off", () => {
	const run = ctx({ mode: "available" });
	eq(fusionCommand("compare A and B", run), "Run the fusion tool now with exactly this prompt, then answer the user in your own words:\n\ncompare A and B", "prompt");
	eq(run.writes, [], "prompt does not touch state");
	const off = ctx({ mode: "off" });
	if (!fusionCommand("compare A and B", off).startsWith("Fusion is off")) throw new Error("expected off message");
});

test("statusText reports mode, config path, panel and tools", () => {
	const text = statusText({ mode: "forced", armedPanel: "quality" }, config, "/p/.claude/fusion.json", "/p");
	for (const needle of ["Fusion mode: forced", "Armed panel: quality", "Config: /p/.claude/fusion.json", "Panel: claude/opus, openrouter/a/b (named panel \"quality\")", "Judge: claude/sonnet", "Panel tools: readonly (max 16 turns, consent no)"]) {
		if (!text.includes(needle)) throw new Error(`missing ${needle} in:\n${text}`);
	}
	const none = statusText({ mode: "available" }, {}, undefined, "/p");
	if (!none.includes("Config: none found")) throw new Error("expected none found");
	if (!none.includes("Panel: unavailable (No panel configured")) throw new Error("expected unavailable panel");
});

test("initCommand writes the example once and never overwrites", () => {
	const dir = mkdtempSync(join(tmpdir(), "claude-fusion-init-"));
	try {
		const first = initCommand(dir);
		if (!first.startsWith(`Wrote ${join(dir, ".claude", "fusion.json")}`)) throw new Error(first);
		const written = JSON.parse(readFileSync(join(dir, ".claude", "fusion.json"), "utf8")) as FusionConfig;
		eq(written.defaultPanel, "default", "example written");
		const second = initCommand(dir);
		if (!second.includes("already exists")) throw new Error(second);
		eq(existsSync(join(dir, ".claude", "fusion.json")), true, "still there");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("userPromptSubmitHook rewrites only plain prompts in forced mode", () => {
	eq(userPromptSubmitHook({ prompt: "hi" }, { mode: "available" }), undefined, "not forced");
	eq(userPromptSubmitHook({ prompt: "/fusion off" }, { mode: "forced" }), undefined, "commands pass");
	eq(userPromptSubmitHook({ prompt: "   " }, { mode: "forced" }), undefined, "blank passes");
	eq(userPromptSubmitHook({ prompt: forceFusionPrompt("x") }, { mode: "forced" }), undefined, "already forced passes");
	eq(userPromptSubmitHook({ prompt: "hi" }, { mode: "forced" }), {
		hookSpecificOutput: { hookEventName: "UserPromptSubmit", updatedInput: { prompt: forceFusionPrompt("hi") } },
	}, "rewritten");
});

test("preToolUseHook denies only when off", () => {
	eq(preToolUseHook({ mode: "forced" }), undefined, "forced allows");
	eq(preToolUseHook({ mode: "off" }), {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: "Fusion is off for this session. Use /fusion available or /fusion on to re-enable it.",
		},
	}, "off denies");
});
