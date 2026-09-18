import { DEFAULT_MAX_TOOL_CALLS, MAX_TOOL_CALLS, MIN_TOOL_CALLS } from "./config.ts";
import type { ToolSelection } from "./types.ts";

export type ToolName = "Read" | "Grep" | "Glob" | "Bash" | "Edit" | "Write";

export const READONLY_TOOL_NAMES: readonly ToolName[] = ["Read", "Grep", "Glob"];
export const MUTATING_TOOL_NAMES: readonly ToolName[] = ["Bash", "Edit", "Write"];
export const ALL_TOOL_NAMES: readonly ToolName[] = [...READONLY_TOOL_NAMES, ...MUTATING_TOOL_NAMES];

const ALIASES: Record<string, ToolName> = {
	read: "Read",
	grep: "Grep",
	glob: "Glob",
	find: "Glob",
	ls: "Glob",
	bash: "Bash",
	edit: "Edit",
	write: "Write",
};

export function selectionToNames(selection: ToolSelection | undefined): ToolName[] {
	if (!selection || selection === "none") return [];
	if (selection === "readonly") return [...READONLY_TOOL_NAMES];
	if (selection === "all") return [...ALL_TOOL_NAMES];
	if (Array.isArray(selection)) {
		const out: ToolName[] = [];
		for (const raw of selection) {
			const name = ALIASES[String(raw).toLowerCase()];
			if (name && !out.includes(name)) out.push(name);
		}
		return out;
	}
	return [];
}

export function isMutatingSelection(selection: ToolSelection | undefined): boolean {
	return selectionToNames(selection).some((n) => MUTATING_TOOL_NAMES.includes(n));
}

export function selectionLabel(selection: ToolSelection | undefined): string {
	if (!selection || selection === "none") return "none";
	if (selection === "readonly" || selection === "all") return selection;
	const names = selectionToNames(selection);
	return names.length ? names.join(",") : "none";
}

export function clampMaxToolCalls(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_TOOL_CALLS;
	return Math.max(MIN_TOOL_CALLS, Math.min(MAX_TOOL_CALLS, Math.floor(value)));
}
