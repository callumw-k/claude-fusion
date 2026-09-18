import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FusionMode } from "./types.ts";

export interface SessionState {
	mode: FusionMode;
	armedPanel?: string;
}

export const DEFAULT_STATE: SessionState = { mode: "available" };

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.FUSION_DATA_DIR ?? join(homedir(), ".claude", "claude-fusion");
}

function sessionPath(dir: string, sessionId: string): string {
	return join(dir, "sessions", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function normalize(value: unknown): SessionState {
	if (typeof value !== "object" || value === null) return { ...DEFAULT_STATE };
	const record = value as Record<string, unknown>;
	const mode: FusionMode = record.mode === "forced" || record.mode === "off" ? record.mode : "available";
	return {
		mode,
		...(typeof record.armedPanel === "string" && record.armedPanel ? { armedPanel: record.armedPanel } : {}),
	};
}

export function resolveSessionId(env: NodeJS.ProcessEnv = process.env, dir: string = stateDir(env)): string | undefined {
	if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
	try {
		const id = readFileSync(join(dir, "current-session"), "utf8").trim();
		return id || undefined;
	} catch {
		return undefined;
	}
}

export function writeCurrentSession(sessionId: string, dir: string = stateDir()): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "current-session"), sessionId);
}

export function readState(sessionId: string, dir: string = stateDir()): SessionState {
	try {
		return normalize(JSON.parse(readFileSync(sessionPath(dir, sessionId), "utf8")));
	} catch {
		return { ...DEFAULT_STATE };
	}
}

export function writeState(sessionId: string, patch: Partial<SessionState>, dir: string = stateDir()): SessionState {
	const next = normalize({ ...readState(sessionId, dir), ...patch });
	mkdirSync(join(dir, "sessions"), { recursive: true });
	writeFileSync(sessionPath(dir, sessionId), JSON.stringify(next));
	return next;
}

export function clearState(sessionId: string, dir: string = stateDir()): void {
	rmSync(sessionPath(dir, sessionId), { force: true });
}

export function consumeArmedPanel(sessionId: string, dir: string = stateDir()): string | undefined {
	const armed = readState(sessionId, dir).armedPanel;
	if (armed) writeState(sessionId, { armedPanel: undefined }, dir);
	return armed;
}
