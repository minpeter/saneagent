import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionPreparation } from "../../../compaction/index.ts";
import type { BeforeAgentStartEventResult } from "../../types.ts";
import { type IdleCompactionDecision, shouldWarmAtIdle } from "./idle.ts";
import * as policy from "./policy.ts";
import { isWarmResultStale, isWithinGraceBand, resolveSpeculationLeadTokens } from "./speculation-lead.ts";
import { admitToolResult, containsToolAdmissionMarker } from "./tool-admission.ts";

export interface CompactionGeometry {
	reserveTokens: number;
	thresholdTokens: number;
	leadTokens: number;
}

export function resolveCompactionGeometry(input: {
	contextWindow: number;
	settings: CompactionPreparation["settings"];
	lastYield?: { savedTokens: number; tokensBefore: number };
}): CompactionGeometry {
	const thresholdTokens = input.contextWindow * policy.computeEffectiveThreshold(input.contextWindow, input.lastYield);
	return {
		reserveTokens: policy.resolveEffectiveReserveTokens(input.contextWindow, input.settings),
		thresholdTokens,
		leadTokens: resolveSpeculationLeadTokens(thresholdTokens, input.settings.speculativeLeadTokens),
	};
}

export function shouldDeferGraceBand(input: {
	tokens: number;
	thresholdTokens: number;
	leadTokens: number;
	contextWindow: number;
	reserveTokens: number;
	compactionInFlight: boolean;
	graceBandEnabled?: boolean;
}): boolean {
	return (
		input.compactionInFlight &&
		input.graceBandEnabled !== false &&
		isWithinGraceBand(input.tokens, input.thresholdTokens, input.leadTokens, input.contextWindow, input.reserveTokens)
	);
}

export function resolveBeforeAgentStartMessage(input: {
	message?: BeforeAgentStartEventResult["message"];
	reminder?: string;
	reminderEnabled?: boolean;
}): BeforeAgentStartEventResult["message"] | undefined {
	if (!input.reminder || input.reminderEnabled === false) return input.message;
	// The reminder only ever rides along on a message the turn was already going to
	// deliver. Returning one from an otherwise empty handler manufactures turn-local
	// context, which suppresses the retry controller's model-fallback dispatch
	// (regressions/compaction-current-model-state).
	if (!input.message) return undefined;
	return { ...input.message, content: `${input.message.content}\n\n${input.reminder}` };
}

export function resolveIdleWarmAction(
	decision: IdleCompactionDecision,
	job: { armedAtTokens: number } | undefined,
): "none" | "start" | "replace" {
	if (!shouldWarmAtIdle(decision)) return "none";
	if (!job) return "start";
	const currentTokens = decision.usage?.tokens ?? 0;
	return isWarmResultStale(job.armedAtTokens, currentTokens, decision.settings.keepRecentTokens) ? "replace" : "none";
}

export function admitContextToolResult(
	text: string,
	contextWindow: number,
	spillDir: string,
): { text: string; admitted: boolean } {
	if (containsToolAdmissionMarker(text)) return { text, admitted: false };
	const result = admitToolResult({ text, contextWindow, spillDir });
	return { text: result.text, admitted: result.spilled };
}

export function admitContextToolResults(
	messages: AgentMessage[],
	contextWindow: number,
	enabled: boolean,
): AgentMessage[] {
	if (!enabled) return messages;
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part: { type: string; text?: string }) => part.type === "text")
						.map((part: { type: string; text?: string }) => part.text ?? "")
						.join("\n");
		if (!text) return message;
		const admitted = admitContextToolResult(text, contextWindow, join(tmpdir(), "senpi-tool-spill"));
		return admitted.admitted ? { ...message, content: [{ type: "text" as const, text: admitted.text }] } : message;
	});
}
