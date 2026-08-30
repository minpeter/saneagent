/**
 * Always-on admission cap for tool results.
 *
 * Oversized tool output is the dominant driver of single-step context bursts, so it is
 * projected to a deterministic head/tail excerpt at the entrance instead of waiting for
 * an emergency/compaction-budget pass (see `tool-truncation.ts`). Admission is derived
 * from the supplied text on every request; model-visible marker text is never state.
 */

import { estimateTokens } from "../../../compaction/index.ts";

const MAX_ADMISSION_CAP_TOKENS = 50_000;
const MIN_ADMISSION_CAP_TOKENS = 8192;
const ADMISSION_CAP_FRACTION = 0.05;
const HEAD_BUDGET_FRACTION = 0.6;
const TAIL_BUDGET_FRACTION = 0.2;

export const TOOL_ADMISSION_MARKER_PREFIX = "[tool result projected:";

export interface AdmitToolResultInput {
	readonly text: string;
	readonly contextWindow: number;
}

export interface AdmitToolResultOutput {
	readonly text: string;
	readonly projected: boolean;
}

/** Token budget a single tool result may occupy before it is projected. */
export function resolveToolResultAdmissionCapTokens(contextWindow: number): number {
	return Math.min(
		MAX_ADMISSION_CAP_TOKENS,
		Math.max(MIN_ADMISSION_CAP_TOKENS, Math.floor(ADMISSION_CAP_FRACTION * contextWindow)),
	);
}

function estimateTextTokens(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

function buildExcerpt(text: string, budgetChars: number, totalTokens: number): string {
	const headChars = Math.floor(budgetChars * HEAD_BUDGET_FRACTION);
	const tailChars = Math.floor(budgetChars * TAIL_BUDGET_FRACTION);
	const head = text.slice(0, headChars);
	const tail = text.slice(Math.max(headChars, text.length - tailChars));
	const keptTokens = estimateTextTokens(head) + estimateTextTokens(tail);
	return `${head}\n${TOOL_ADMISSION_MARKER_PREFIX} kept ${keptTokens} of ~${totalTokens} tokens]\n${tail}`;
}

/**
 * Cap a tool result at admission time. Under-cap text passes through untouched; over-cap
 * text becomes a deterministic, diskless head/tail projection. Re-evaluating projected
 * text under a smaller model window is safe because admission never trusts marker text.
 */
export function admitToolResult(input: AdmitToolResultInput): AdmitToolResultOutput {
	const capTokens = resolveToolResultAdmissionCapTokens(input.contextWindow);
	const totalTokens = estimateTextTokens(input.text);
	if (totalTokens <= capTokens) return { text: input.text, projected: false };

	const charsPerToken = input.text.length / Math.max(1, totalTokens);
	let budgetChars = Math.floor(capTokens * charsPerToken);
	let excerpt = buildExcerpt(input.text, budgetChars, totalTokens);
	while (estimateTextTokens(excerpt) > capTokens) {
		budgetChars = Math.floor(budgetChars * 0.8);
		excerpt = buildExcerpt(input.text, budgetChars, totalTokens);
	}

	return { text: excerpt, projected: true };
}
