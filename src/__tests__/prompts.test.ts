import { FUSION_ANALYSIS_SCHEMA } from "../prompts.ts";
import { eq, test } from "./_harness.ts";

function objectsIn(node: unknown, path: string, out: Array<{ path: string; node: Record<string, unknown> }>): void {
	if (typeof node !== "object" || node === null) return;
	const record = node as Record<string, unknown>;
	if (record.type === "object") out.push({ path, node: record });
	for (const [key, value] of Object.entries(record)) objectsIn(value, `${path}.${key}`, out);
}

test("the judge schema is strict enough for OpenAI structured outputs", () => {
	const objects: Array<{ path: string; node: Record<string, unknown> }> = [];
	objectsIn(FUSION_ANALYSIS_SCHEMA, "schema", objects);
	if (objects.length < 5) throw new Error(`expected nested objects, found ${objects.length}`);
	for (const { path, node } of objects) {
		eq(node.additionalProperties, false, `${path} closes additionalProperties`);
		eq(node.required, Object.keys(node.properties as Record<string, unknown>), `${path} requires every property`);
	}
});
