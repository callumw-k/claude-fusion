/**
 * System prompts and prompt utilities for claude-fusion.
 */

import { truncateToBytes } from "./utils.ts";

export const PANEL_SYSTEM_PROMPT = `You are an independent panelist in a multi-model deliberation.

Answer the user's question thoroughly and to the best of your ability. You do not have access to tools; rely on your training knowledge. Be concise but complete. Do not mention that you are part of a panel or refer to other models.`;

export const PANEL_SYSTEM_PROMPT_WITH_TOOLS = `You are an independent panelist in a multi-model deliberation.

Answer the user's question thoroughly and to the best of your ability. You have access to tools (e.g. reading files and searching the codebase) — use them to gather concrete evidence before answering when it helps, then write a complete final answer in text. Keep tool use focused; do not loop. Be concise but complete. Do not mention that you are part of a panel or refer to other models.`;

export const JUDGE_SYSTEM_PROMPT = `You are a critical judge comparing responses from a panel of AI models.

Given a task and the panel responses, return ONLY a JSON object with exactly this shape and no markdown code fences:

{
  "consensus": ["Points all or most panel models agree on. Treat these as higher-confidence."],
  "contradictions": [
    {
      "topic": "What they disagree about",
      "stances": [
        {"model": "provider/id", "stance": "What this model said"}
      ]
    }
  ],
  "partial_coverage": [
    {"models": ["provider/id"], "point": "Point only some models covered"}
  ],
  "unique_insights": [
    {"model": "provider/id", "insight": "Something only one model raised"}
  ],
  "blind_spots": ["Topics none of the panel models addressed"]
}

Guidelines:
- Compare rather than merge. Do not average opinions.
- Treat agreement across models as higher-confidence consensus.
- Surface real contradictions; do not invent them.
- Preserve unique insights from individual models.
- Flag blind spots the panel missed entirely.
- Output valid JSON only.`;

export function truncateForJudge(text: string, maxBytes: number): string {
	return truncateToBytes(text, maxBytes, "\n\n[truncated for judge context window]");
}

export const FUSION_ANALYSIS_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		consensus: { type: "array", items: { type: "string" } },
		contradictions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					topic: { type: "string" },
					stances: {
						type: "array",
						items: {
							type: "object",
							properties: { model: { type: "string" }, stance: { type: "string" } },
							required: ["model", "stance"],
							additionalProperties: false,
						},
					},
				},
				required: ["topic", "stances"],
				additionalProperties: false,
			},
		},
		partial_coverage: {
			type: "array",
			items: {
				type: "object",
				properties: { models: { type: "array", items: { type: "string" } }, point: { type: "string" } },
				required: ["models", "point"],
				additionalProperties: false,
			},
		},
		unique_insights: {
			type: "array",
			items: {
				type: "object",
				properties: { model: { type: "string" }, insight: { type: "string" } },
				required: ["model", "insight"],
				additionalProperties: false,
			},
		},
		blind_spots: { type: "array", items: { type: "string" } },
	},
	required: ["consensus", "contradictions", "partial_coverage", "unique_insights", "blind_spots"],
	additionalProperties: false,
};
