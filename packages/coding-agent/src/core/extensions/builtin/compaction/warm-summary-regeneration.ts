import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface WarmSummaryRegeneration {
	previousWarmSummary?: string;
}

export function previousWarmSummaryMessages(summary?: string): AgentMessage[] {
	if (!summary) return [];
	return [
		{
			role: "user",
			content: [{ type: "text", text: `<previous-warm-summary>\n${summary}\n</previous-warm-summary>` }],
			timestamp: Date.now(),
		},
	];
}
