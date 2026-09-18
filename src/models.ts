import { parseModelRef, sameRef } from "./backends/registry.ts";
import { MAX_PANEL_MODELS_HARD_LIMIT } from "./config.ts";
import type { ModelRef } from "./types.ts";

export type ResolveSource = "explicit" | "default" | "legacy";

export interface ResolveCandidate {
	source: ResolveSource;
	panel: string[];
	judge?: string;
	maxPanelModels: number;
	profileName?: string;
	/** Fail closed when the candidate resolves to no models. */
	strict?: boolean;
}

export interface ResolveResult {
	panel: ModelRef[];
	judge: ModelRef;
	warnings: string[];
	source: ResolveSource;
	profileName?: string;
}

export interface ResolveOptions {
	candidates: ResolveCandidate[];
	warnings?: string[];
}

export const NO_PANEL_MESSAGE = "No panel configured. Run /fusion-init to create .claude/fusion.json.";

export class PanelSelectionError extends Error {
	readonly profileName: string | undefined;
	readonly warnings: string[];

	constructor(profileName: string | undefined, warnings: string[], message: string) {
		super(message);
		this.name = "PanelSelectionError";
		this.profileName = profileName;
		this.warnings = warnings;
	}
}

function resolvePanelIdentifiers(identifiers: string[], maxPanel: number, warnings: string[]): ModelRef[] {
	const panel: ModelRef[] = [];
	for (const id of identifiers) {
		const ref = parseModelRef(id);
		if (!ref) {
			warnings.push(`Unknown model identifier: ${id}`);
			continue;
		}
		if (!panel.some((m) => sameRef(m, ref))) panel.push(ref);
		if (panel.length >= maxPanel) break;
	}
	return panel;
}

export function resolvePanelAndJudge(options: ResolveOptions): ResolveResult {
	const warnings = [...(options.warnings ?? [])];
	let panel: ModelRef[] = [];
	let selected: ResolveCandidate | undefined;

	for (const candidate of options.candidates) {
		if (candidate.panel.length === 0) continue;
		const maxPanel = Math.min(candidate.maxPanelModels, MAX_PANEL_MODELS_HARD_LIMIT);
		panel = resolvePanelIdentifiers(candidate.panel, maxPanel, warnings);
		if (panel.length > 0) {
			selected = candidate;
			break;
		}
		const label = candidate.profileName ? `Named panel "${candidate.profileName}"` : "Legacy panel";
		const message = `${label} contained no valid model identifiers.`;
		warnings.push(candidate.strict ? message : `${message} Trying the next configured candidate.`);
		if (candidate.strict) throw new PanelSelectionError(candidate.profileName, warnings, message);
	}

	if (!selected) throw new PanelSelectionError(undefined, warnings, NO_PANEL_MESSAGE);

	let judge: ModelRef | undefined;
	if (selected.judge) {
		judge = parseModelRef(selected.judge);
		if (!judge) warnings.push(`Unknown judge identifier: ${selected.judge}`);
	}
	if (!judge) judge = panel[0];

	return {
		panel,
		judge,
		warnings,
		source: selected.source,
		...(selected.profileName ? { profileName: selected.profileName } : {}),
	};
}
