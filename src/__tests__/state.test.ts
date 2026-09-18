import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearState, consumeArmedPanel, readState, resolveSessionId, stateDir, writeCurrentSession, writeState } from "../state.ts";
import { eq, test } from "./_harness.ts";

function withDir(fn: (dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "claude-fusion-state-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("stateDir honours FUSION_DATA_DIR and defaults under ~/.claude", () => {
	eq(stateDir({ FUSION_DATA_DIR: "/x/y" }), "/x/y", "override");
	if (!stateDir({}).endsWith(join(".claude", "claude-fusion"))) throw new Error(`unexpected default: ${stateDir({})}`);
});

test("readState defaults to available and survives missing or corrupt files", () => {
	withDir((dir) => {
		eq(readState("s1", dir), { mode: "available" }, "missing file");
		mkdirSync(join(dir, "sessions"));
		writeFileSync(join(dir, "sessions", "s1.json"), "{not json");
		eq(readState("s1", dir), { mode: "available" }, "corrupt file");
		writeFileSync(join(dir, "sessions", "s1.json"), JSON.stringify({ mode: "bogus", armedPanel: 3 }));
		eq(readState("s1", dir), { mode: "available" }, "invalid values normalised");
	});
});

test("writeState merges, clearState removes, consumeArmedPanel is one-shot", () => {
	withDir((dir) => {
		eq(writeState("s1", { mode: "forced" }, dir), { mode: "forced" }, "write mode");
		eq(writeState("s1", { armedPanel: "quality" }, dir), { mode: "forced", armedPanel: "quality" }, "merge armed");
		eq(consumeArmedPanel("s1", dir), "quality", "consumed");
		eq(readState("s1", dir), { mode: "forced" }, "armed cleared, mode kept");
		eq(consumeArmedPanel("s1", dir), undefined, "second consume empty");
		eq(writeState("s1", { mode: "off", armedPanel: undefined }, dir), { mode: "off" }, "explicit undefined clears");
		clearState("s1", dir);
		eq(existsSync(join(dir, "sessions", "s1.json")), false, "file removed");
		clearState("s1", dir);
	});
});

test("session ids are sanitised into file names", () => {
	withDir((dir) => {
		writeState("../evil/../id", { mode: "off" }, dir);
		eq(existsSync(join(dir, "sessions", "___evil____id.json")), true, "sanitised path");
	});
});

test("resolveSessionId prefers the env var then the current-session pointer", () => {
	withDir((dir) => {
		eq(resolveSessionId({}, dir), undefined, "nothing");
		writeCurrentSession("from-hook", dir);
		eq(resolveSessionId({}, dir), "from-hook", "pointer");
		eq(resolveSessionId({ CLAUDE_CODE_SESSION_ID: "from-env" }, dir), "from-env", "env wins");
	});
});
