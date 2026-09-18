/**
 * Tests for named-panel config selection and defaults.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyDefaults,
	configPaths,
	generateConfigExample,
	loadConfigWithPath,
	parseFusionConfig,
	resolveEffectiveConfig,
	THINKING_LEVELS,
} from "../config.ts";
import type { FusionConfig } from "../types.ts";
import { eq, test } from "./_harness.ts";

const namedConfig: FusionConfig = {
	panel: ["legacy/panel"],
	judge: "legacy/judge",
	panelReasoning: "low",
	judgeReasoning: "medium",
	defaultPanel: "quality",
	panels: {
		quality: {
			models: ["openai/gpt-5.5", "anthropic/claude-sonnet-5"],
			judge: "openai/gpt-5.5",
			panelReasoning: "high",
		},
		fast: {
			models: ["openai/gpt-5.4"],
			judgeReasoning: "minimal",
		},
	},
};

test("explicit named panel overrides the default and inherits omitted role settings", () => {
	const result = resolveEffectiveConfig(namedConfig, "fast");
	if (!result.ok) throw new Error(result.error.message);

	eq(result.profileName, "fast", "explicit panel is identified");
	eq(result.source, "explicit", "selection source is explicit");
	eq(result.config.panel, ["openai/gpt-5.4"], "named models replace legacy panel");
	eq(result.config.judge, "legacy/judge", "omitted named judge inherits top-level judge");
	eq(result.config.panelReasoning, "low", "omitted panel reasoning inherits top-level effort");
	eq(result.config.judgeReasoning, "minimal", "named judge reasoning overrides top-level effort");
	eq(result.warnings, [], "valid explicit panel has no warnings");
});

test("defaultPanel selects a named panel and applies role overrides independently", () => {
	const result = resolveEffectiveConfig(namedConfig);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.profileName, "quality", "default panel is identified");
	eq(result.source, "default", "selection source is default");
	eq(result.config.panel, ["openai/gpt-5.5", "anthropic/claude-sonnet-5"], "default models selected");
	eq(result.config.judge, "openai/gpt-5.5", "default judge selected");
	eq(result.config.panelReasoning, "high", "named panel reasoning overrides top-level effort");
	eq(result.config.judgeReasoning, "medium", "omitted named judge effort inherits top-level effort");
});

test("legacy-only config remains unchanged apart from numeric defaults", () => {
	const legacy: FusionConfig = {
		panel: ["anthropic/claude-sonnet-4-5"],
		judge: "anthropic/claude-opus-4-5",
		maxPanelModels: 6,
		panelTools: "readonly",
	};
	const result = resolveEffectiveConfig(legacy);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.source, "legacy", "legacy source retained");
	eq(result.profileName, undefined, "legacy config has no profile name");
	eq(result.config.panel, legacy.panel, "legacy panel retained");
	eq(result.config.judge, legacy.judge, "legacy judge retained");
	eq(result.config.maxPanelModels, 6, "configured panel limit retained");
	eq(result.config.panelTools, "readonly", "unrelated config retained");
});

test("explicit unknown named panel returns a strict typed error", () => {
	const result = resolveEffectiveConfig(namedConfig, "missing");
	if (result.ok) throw new Error("expected strict selection failure");

	eq(result.error.code, "unknown_named_panel", "unknown panel error code");
	eq(result.error.panelName, "missing", "unknown panel error identifies request");
	eq(result.warnings, [], "strict error does not downgrade to a warning");
});

test("explicit malformed or empty named panels return strict errors", () => {
	const config = {
		panels: {
			empty: { models: [] },
			malformed: { models: ["valid/model", 42] },
			badReasoning: { models: ["valid/model"], panelReasoning: "maximum" },
		},
	} as unknown as FusionConfig;

	for (const name of ["empty", "malformed", "badReasoning"]) {
		const result = resolveEffectiveConfig(config, name);
		if (result.ok) throw new Error(`expected ${name} to fail`);
		eq(result.error.code, "invalid_named_panel", `${name} error code`);
		eq(result.error.panelName, name, `${name} error identifies request`);
	}
});

test("invalid configured default warns and falls through to legacy config", () => {
	const config: FusionConfig = {
		panel: ["legacy/panel"],
		judge: "legacy/judge",
		defaultPanel: "missing",
		panels: {},
	};
	const result = resolveEffectiveConfig(config);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.source, "legacy", "invalid default falls through");
	eq(result.config.panel, ["legacy/panel"], "legacy panel retained after invalid default");
	eq(result.config.judge, "legacy/judge", "legacy judge retained after invalid default");
	if (!result.warnings.some((warning) => warning.includes('defaultPanel "missing"'))) {
		throw new Error(`missing deterministic default warning: ${JSON.stringify(result.warnings)}`);
	}
});

test("invalid top-level reasoning is omitted with deterministic warnings", () => {
	const config = {
		panel: ["legacy/panel"],
		panelReasoning: "maximum",
		judgeReasoning: 3,
	} as unknown as FusionConfig;
	const result = resolveEffectiveConfig(config);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.config.panelReasoning, undefined, "invalid panel effort omitted");
	eq(result.config.judgeReasoning, undefined, "invalid judge effort omitted");
	eq(result.warnings.length, 2, "both invalid efforts warn");
});

test("max reasoning is accepted at top level and in named panels", () => {
	const config: FusionConfig = {
		panelReasoning: "max",
		judgeReasoning: "max",
		panels: {
			explicit: {
				models: ["provider/panel"],
				judgeReasoning: "max",
			},
			default: {
				models: ["provider/panel"],
				panelReasoning: "max",
			},
		},
		defaultPanel: "default",
	};

	const explicit = resolveEffectiveConfig(config, "explicit");
	if (!explicit.ok) throw new Error(explicit.error.message);
	eq(explicit.config.panelReasoning, "max", "explicit panel inherits top-level max");
	eq(explicit.config.judgeReasoning, "max", "explicit panel preserves judge max");
	eq(explicit.warnings, [], "valid explicit max values do not warn");

	const selectedDefault = resolveEffectiveConfig(config);
	if (!selectedDefault.ok) throw new Error(selectedDefault.error.message);
	eq(selectedDefault.config.panelReasoning, "max", "default panel preserves panel max");
	eq(selectedDefault.config.judgeReasoning, "max", "default panel inherits top-level judge max");
	eq(selectedDefault.warnings, [], "valid default max values do not warn");
});

test("thinking levels remain ordered and reject non-canonical max spellings", () => {
	eq(THINKING_LEVELS, ["minimal", "low", "medium", "high", "xhigh", "max"], "shared reasoning order");

	const config = {
		panelReasoning: "MAX",
		judgeReasoning: "maximum",
	} as unknown as FusionConfig;
	const result = resolveEffectiveConfig(config);
	if (!result.ok) throw new Error(result.error.message);

	eq(result.config.panelReasoning, undefined, "uppercase max remains invalid");
	eq(result.config.judgeReasoning, undefined, "maximum remains invalid");
	eq(result.warnings, [
		"Invalid panelReasoning value; omitting it. Expected minimal, low, medium, high, xhigh, max.",
		"Invalid judgeReasoning value; omitting it. Expected minimal, low, medium, high, xhigh, max.",
	], "invalid warnings list the canonical ordered values");
});

test("applyDefaults fills every numeric knob including timeoutSeconds", () => {
	const result = applyDefaults({ panel: ["claude/opus"] });
	eq(result.panel, ["claude/opus"], "panel retained");
	eq(result.timeoutSeconds, 600, "timeout default");
	eq(result.maxToolCalls, 16, "tool call default");
	eq(applyDefaults({ timeoutSeconds: 30 }).timeoutSeconds, 30, "configured timeout retained");
});

test("generated config uses a resolvable named default panel with both backends", () => {
	const example = generateConfigExample();
	eq(example.defaultPanel, "default", "generated config names its default panel");
	eq(example.panels?.default.models?.[0], "claude/opus", "first panelist is a claude model");
	if (!example.panels?.default.models?.some((m) => m.startsWith("openrouter/"))) throw new Error("expected an openrouter panelist");
	eq(example.panels?.default.judge, "claude/opus", "judge is a claude model");
	eq(example.timeoutSeconds, 600, "example carries the timeout knob");
	const resolved = resolveEffectiveConfig(example);
	if (!resolved.ok) throw new Error(resolved.error.message);
	eq(resolved.profileName, "default", "generated config resolves through named-panel path");
	if (example.panels?.default.models?.[2] !== "openrouter/google/gemini-3.8-flash") {
		throw new Error(`expected gemini-3.8-flash, got ${example.panels?.default.models?.[2]}`);
	}
});

test("loadConfigWithPath prefers the project file and reports the path", () => {
	const project = mkdtempSync(join(tmpdir(), "claude-fusion-config-"));
	try {
		eq(loadConfigWithPath(project).path, undefined, "no file means no path");
		mkdirSync(join(project, ".claude"));
		writeFileSync(join(project, ".claude", "fusion.json"), JSON.stringify({ panel: ["claude/opus"] }));
		const loaded = loadConfigWithPath(project);
		eq(loaded.config.panel, ["claude/opus"], "project config loaded");
		eq(loaded.path, join(project, ".claude", "fusion.json"), "project path reported");
		eq(configPaths(project)[0], join(project, ".claude", "fusion.json"), "project path first");
		if (!configPaths(project)[1].endsWith(join(".claude", "fusion.json"))) throw new Error("global path should end with .claude/fusion.json");
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("config parser rejects non-object JSON roots", () => {
	for (const value of ["null", "[]", '"panel"']) {
		let error: unknown;
		try {
			parseFusionConfig(value);
		} catch (caught) {
			error = caught;
		}
		if (!(error instanceof Error) || !error.message.includes("JSON object")) {
			throw new Error(`expected object-root error for ${value}`);
		}
	}
});
