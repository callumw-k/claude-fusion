import { EventEmitter } from "node:events";
import type { SpawnLike } from "../backends/spawn.ts";

export interface FakeSpawn {
	spawn: SpawnLike;
	calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined; stdin: string }>;
	kills: string[];
}

export interface FakeExit {
	stdout?: string;
	stderr?: string;
	code?: number;
	onSpawn?: (args: string[]) => void;
}

export function fakeSpawn(exit?: FakeExit): FakeSpawn {
	const record: FakeSpawn = { calls: [], kills: [], spawn: undefined as unknown as SpawnLike };
	record.spawn = ((command: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
		const call = { command, args: [...args], env: opts.env, stdin: "" };
		record.calls.push(call);
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { end(data?: string): void }; kill(signal: string): boolean };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = Object.assign(new EventEmitter(), {
			end(data?: string) {
				call.stdin = data ?? "";
			},
		});
		child.kill = (signal: string) => {
			record.kills.push(signal);
			setImmediate(() => child.emit("close", null));
			return true;
		};
		if (exit !== undefined) {
			setImmediate(() => {
				exit.onSpawn?.(call.args);
				if (exit.stdout !== undefined) child.stdout.emit("data", exit.stdout);
				if (exit.stderr !== undefined) child.stderr.emit("data", exit.stderr);
				child.emit("close", exit.code ?? 0);
			});
		}
		return child;
	}) as unknown as SpawnLike;
	return record;
}
