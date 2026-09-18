import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createClaudeBackend } from "./backends/claude.ts";
import { createCodexBackend } from "./backends/codex.ts";
import { createOpenRouterBackend } from "./backends/openrouter.ts";
import type { Backends } from "./backends/types.ts";
import { loadConfig } from "./config.ts";
import { formatResult } from "./format.ts";
import { disabledFusionResult, runFusion } from "./fusion.ts";
import { consumeArmedPanel, readState, resolveSessionId } from "./state.ts";
import type { FusionResult } from "./types.ts";

const VERSION = "0.1.0";

const FUSION_DESCRIPTION = [
	"Multi-model deliberation tool inspired by OpenRouter Fusion.",
	"Use fusion when a single perspective is not enough: research questions, expert critique, compare/contrast tasks, or decisions where being wrong is expensive.",
	"Runs the prompt against a configured panel of models in parallel, then a judge compares responses and returns structured analysis (consensus, contradictions, partial coverage, unique insights, blind spots).",
	"Panel and judge are configured in .claude/fusion.json or ~/.claude/fusion.json; the tool cannot choose them.",
	"Use it only when a task genuinely benefits from multiple perspectives, not for simple tactical prompts, routine edits, or questions a single model answers well.",
	"Panel and judge calls do not see this conversation. Put any context the panel needs into the prompt.",
].join(" ");

const PROMPT_DESCRIPTION = "The question or task for the panel, including any context it needs.";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const backends: Backends = { claude: createClaudeBackend(), codex: createCodexBackend(), openrouter: createOpenRouterBackend() };
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

async function execute(prompt: string, extra: Extra): Promise<FusionResult> {
	const sessionId = resolveSessionId();
	if (sessionId && readState(sessionId).mode === "off") return disabledFusionResult();
	const armed = sessionId ? consumeArmedPanel(sessionId) : undefined;
	const token = extra._meta?.progressToken;
	let step = 0;
	return runFusion({
		projectDir,
		config: loadConfig(projectDir),
		backends,
		prompt,
		overrides: { panel_profile: armed },
		consented: false,
		signal: extra.signal,
		onProgress: (message) => {
			if (token === undefined) return;
			step++;
			void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message } }).catch(() => {});
		},
	});
}

function toolResult(text: string, result: FusionResult) {
	return { content: [{ type: "text" as const, text }], isError: result.details.status === "error" };
}

function errorResult(err: unknown) {
	const message = err instanceof Error ? err.message : String(err);
	console.error("[claude-fusion] tool failed:", err);
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ status: "error", error: message, failure_reason: "unexpected_error" }, null, 2) }],
		isError: true,
	};
}

const server = new McpServer({ name: "claude-fusion", version: VERSION });

server.registerTool(
	"fusion",
	{ description: FUSION_DESCRIPTION, inputSchema: { prompt: z.string().describe(PROMPT_DESCRIPTION) } },
	async ({ prompt }, extra) => {
		try {
			const result = await execute(prompt, extra);
			return toolResult(result.content[0].text, result);
		} catch (err) {
			return errorResult(err);
		}
	},
);

server.registerTool(
	"fusion_report",
	{
		description: "Run fusion and return the full diagnostic report (judge analysis plus every panel response) as markdown. Backs /fusion-report.",
		inputSchema: { prompt: z.string().describe(PROMPT_DESCRIPTION) },
	},
	async ({ prompt }, extra) => {
		try {
			const result = await execute(prompt, extra);
			return toolResult(result.details.status === "error" ? result.content[0].text : formatResult(result.details), result);
		} catch (err) {
			return errorResult(err);
		}
	},
);

await server.connect(new StdioServerTransport());
