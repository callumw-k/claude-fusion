import type { BackendName, ModelRef } from "../types.ts";

const BACKEND_NAMES: readonly BackendName[] = ["claude", "codex", "agy", "openrouter"];

function isBackendName(value: string): value is BackendName {
	return (BACKEND_NAMES as readonly string[]).includes(value);
}

export function parseModelRef(id: string): ModelRef | undefined {
	const trimmed = id.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return undefined;
	const backend = trimmed.slice(0, slash);
	const model = trimmed.slice(slash + 1);
	if (!isBackendName(backend) || model.length === 0) return undefined;
	return { backend, model, display: `${backend}/${model}` };
}

export function modelDisplay(ref: ModelRef): string {
	return ref.display;
}

export function sameRef(a: ModelRef, b: ModelRef): boolean {
	return a.display === b.display;
}
