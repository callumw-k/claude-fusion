import { spawn } from "node:child_process";

export type SpawnLike = typeof spawn;

const CHILD_ENV_STRIPPED = ["OPENROUTER_API_KEY", "CLAUDE_CODE_SESSION_ID"];

export function buildChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child = { ...env };
	for (const key of CHILD_ENV_STRIPPED) delete child[key];
	return child;
}

export function abortError(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason as { name?: string } | undefined;
	return new Error(reason?.name === "TimeoutError" ? "timed out" : "cancelled");
}

export interface CliRun {
	command: string;
	args: string[];
	cwd: string;
	stdin: string;
	signal?: AbortSignal;
}

export function runCli<T>(
	spawnImpl: SpawnLike,
	run: CliRun,
	parse: (stdout: string, stderr: string, exitCode: number | null) => T,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const child = spawnImpl(run.command, run.args, {
			cwd: run.cwd,
			env: buildChildEnv(process.env),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		const onAbort = () => child.kill("SIGTERM");
		run.signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => run.signal?.removeEventListener("abort", onAbort);
		child.on("error", (err: NodeJS.ErrnoException) => {
			cleanup();
			reject(err.code === "ENOENT" ? new Error(`${run.command} CLI not found on PATH`) : err);
		});
		child.on("close", (code) => {
			cleanup();
			if (run.signal?.aborted) {
				reject(abortError(run.signal));
				return;
			}
			try {
				resolve(parse(stdout, stderr, code));
			} catch (err) {
				reject(err);
			}
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(run.stdin);
	});
}
